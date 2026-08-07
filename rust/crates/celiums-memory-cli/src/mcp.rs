// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! MCP stdio server over the embedded memory engine.
//!
//! Newline-delimited JSON-RPC 2.0, MCP protocol `2025-11-25`, 19 tools:
//! memory, journal, entity graph, consolidation, lifecycle, snapshots,
//! time-travel recall and circadian status. The transport pattern
//! follows Hyphae's bounded stdio adapter (`hyphae-cli/src/mcp.rs`);
//! the engine is embedded directly — no HTTP hop, no services.
//!
//! Embeddings: callers may pass a pre-computed `embedding` array with
//! `remember`/`recall`; without one the engine's deterministic offline
//! embedder is used, so the binary works with zero providers.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{self, BufRead, Write};
use std::time::{Duration, Instant};

use celiums_cognition::{DisclosureAuthority, EntityKind, JournalEntryType, MemoryPurpose, Scope};
use celiums_memory_engine::{
    AgentId, BranchAbstention, CaptureAdapter, CaptureEvent, ConversationId,
    EmbeddingNormalization, EmbeddingSpaceIdentity, IdempotencyKey, JournalRecallRequest,
    JournalWriteRequest, MemoryEngine, MemoryIdentity, MemoryPatch, ProjectId, Provenance,
    RecallConfig, RecallRequest, RecallScope, RememberContext, RememberRequest, ScoredMemory,
    SessionId, SourceEventId, SourceKind, TenantId, TurnId, UpdateMemoryRequest, UserId,
    deterministic_embed, recall_at, snapshot_points,
};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::{Value, json};
use std::path::PathBuf;
use uuid::Uuid;

/// MCP protocol revision, matching the Hyphae adapter.
const MCP_PROTOCOL: &str = "2025-11-25";
/// Maximum accepted message size.
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
/// Default recall limit when the tool call omits one.
const DEFAULT_RECALL_LIMIT: usize = 10;

/// One MCP session over an embedded engine.
pub struct Session {
    engine: MemoryEngine,
    dimension: u16,
    data_dir: PathBuf,
    initialize_seen: bool,
    initialized: bool,
    subscriptions: BTreeSet<String>,
    pending_notifications: VecDeque<Value>,
    pending_resource_changes: VecDeque<ResourceChange>,
    authenticated_remote: bool,
    confirmations: HashMap<String, LocalConfirmation>,
    local_tenant: TenantId,
}

struct LocalConfirmation {
    operation: String,
    resource_id: String,
    expires_at: Instant,
}

#[derive(Clone, Copy)]
struct DisclosureContext {
    authority: DisclosureAuthority,
    purpose: MemoryPurpose,
}

/// Memory-resource changes produced by one successful MCP operation.
#[derive(Clone, Debug, Default)]
pub(crate) struct ResourceChange {
    /// Whether the visible resource list may have changed.
    pub list_changed: bool,
    /// Canonical resources whose representation changed.
    pub updated_uris: BTreeSet<String>,
    /// Whether every user in the tenant must invalidate its resource list.
    pub tenant_wide: bool,
}

struct ToolOutcome {
    value: Value,
    resource_change: Option<ResourceChange>,
}

impl Session {
    /// Creates a session that owns `engine`. `data_dir` locates the
    /// snapshot directory for time-travel tools.
    pub fn new(engine: MemoryEngine, dimension: u16, data_dir: PathBuf) -> Self {
        let local_tenant = engine.tenant_id().clone();
        Self {
            engine,
            dimension,
            data_dir,
            initialize_seen: false,
            initialized: false,
            subscriptions: BTreeSet::new(),
            pending_notifications: VecDeque::new(),
            pending_resource_changes: VecDeque::new(),
            authenticated_remote: false,
            confirmations: HashMap::new(),
            local_tenant,
        }
    }

    /// Exposes the owned engine to the native application actor.
    pub fn engine_mut(&mut self) -> &mut MemoryEngine {
        &mut self.engine
    }

    /// Runs the session until end of input.
    ///
    /// # Errors
    ///
    /// Returns an error on fatal I/O failure. Malformed peer requests
    /// receive JSON-RPC errors and never terminate the session.
    pub fn run(&mut self, input: &mut impl BufRead, output: &mut impl Write) -> io::Result<()> {
        loop {
            let Some(line) = read_bounded_line(input)? else {
                output.flush()?;
                return Ok(());
            };
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let response = match serde_json::from_slice::<Value>(&line) {
                Ok(message) => self.handle(&message),
                Err(_) => Some(rpc_error(&Value::Null, -32700, "Parse error")),
            };
            if let Some(response) = response {
                serde_json::to_writer(&mut *output, &response)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                output.write_all(b"\n")?;
            }
            while let Some(notification) = self.pending_notifications.pop_front() {
                serde_json::to_writer(&mut *output, &notification)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                output.write_all(b"\n")?;
            }
            output.flush()?;
        }
    }

    /// Handles one JSON-RPC message; `None` means no response
    /// (notification).
    pub fn handle(&mut self, message: &Value) -> Option<Value> {
        let mut message = message.clone();
        inject_local_identity(&mut message, &self.local_tenant);
        self.handle_with_disclosure(&message, None)
    }

    /// Handles one request with transport-authenticated disclosure policy.
    pub(crate) fn handle_authenticated(
        &mut self,
        message: &Value,
        authority: DisclosureAuthority,
        purpose: MemoryPurpose,
    ) -> Option<Value> {
        self.authenticated_remote = true;
        self.handle_with_disclosure(message, Some(DisclosureContext { authority, purpose }))
    }

    fn handle_with_disclosure(
        &mut self,
        message: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Option<Value> {
        let Some(object) = message.as_object() else {
            return Some(rpc_error(&Value::Null, -32600, "Invalid Request"));
        };
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(rpc_error(&request_id(object), -32600, "Invalid Request"));
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return Some(rpc_error(&request_id(object), -32600, "Invalid Request"));
        };
        let id = object.get("id").cloned();
        if id
            .as_ref()
            .is_some_and(|value| !value.is_string() && !value.is_i64() && !value.is_u64())
        {
            return Some(rpc_error(&Value::Null, -32600, "Invalid Request"));
        }
        let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return id.map(|id| rpc_error(&id, -32602, "Invalid params"));
        }
        if id.is_none() {
            if method == "notifications/initialized" && self.initialize_seen {
                self.initialized = true;
            }
            return None;
        }
        let id = id.unwrap_or(Value::Null);
        if method == "notifications/initialized" {
            return Some(rpc_error(&id, -32600, "Invalid Request"));
        }
        match method {
            "initialize" => Some(self.initialize(&id, &params)),
            "ping" => Some(rpc_result(&id, &json!({}))),
            _ if !self.initialized => Some(rpc_error(&id, -32002, "Server not initialized")),
            "tools/list" => Some(rpc_result(&id, &json!({ "tools": tool_definitions() }))),
            "tools/call" => Some(self.call_tool(&id, &params, disclosure)),
            "resources/list" => Some(self.list_resources(&id, &params, disclosure)),
            "resources/templates/list" => Some(self.list_resource_templates(&id)),
            "resources/read" => Some(self.read_resource(&id, &params, disclosure)),
            "resources/subscribe" => Some(self.subscribe_resource(&id, &params, disclosure)),
            "resources/unsubscribe" => Some(self.unsubscribe_resource(&id, &params)),
            _ => Some(rpc_error(&id, -32601, "Method not found")),
        }
    }

    /// Drains server-initiated notifications produced by the last request.
    pub fn drain_notifications(&mut self) -> Vec<Value> {
        self.pending_notifications.drain(..).collect()
    }

    /// Drains typed resource changes produced by the last request.
    pub(crate) fn drain_resource_changes(&mut self) -> Vec<ResourceChange> {
        self.pending_resource_changes.drain(..).collect()
    }

    fn initialize(&mut self, id: &Value, params: &Value) -> Value {
        if self.initialize_seen
            || params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .is_none()
            || !params.get("capabilities").is_some_and(Value::is_object)
            || !params.get("clientInfo").is_some_and(Value::is_object)
        {
            return rpc_error(id, -32602, "Invalid initialize params");
        }
        self.initialize_seen = true;
        rpc_result(
            id,
            &json!({
                "protocolVersion": MCP_PROTOCOL,
                "capabilities": {
                    "tools": { "listChanged": false },
                    "resources": { "subscribe": true, "listChanged": true }
                },
                "serverInfo": {
                    "name": "celiums-memory",
                    "title": "Celiums Memory cognitive engine",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": "Persistent cognitive memory: remember/recall with hybrid \
                    retrieval and affective re-ranking, plus a hash-chained first-person \
                    journal per agent. Fully embedded - no external services."
            }),
        )
    }

    fn call_tool(
        &mut self,
        id: &Value,
        params: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Value {
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return rpc_error(id, -32602, "Tool name is required");
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return rpc_error(id, -32602, "Tool arguments must be an object");
        }
        if let Some(message) = arguments
            .get("_invalid_operation_key")
            .and_then(Value::as_str)
        {
            return rpc_result(id, &tool_error(message));
        }
        if name == "remember" {
            return match self.tool_remember_outcome(&arguments) {
                Ok(outcome) => {
                    if let Some(change) = outcome.resource_change {
                        self.notify_resource_changes(change);
                    }
                    rpc_result(id, &tool_success(&outcome.value))
                }
                Err(message) => rpc_result(id, &tool_error(&message)),
            };
        }
        if name == "confirm_destructive" {
            return match self.tool_confirm_destructive(&arguments) {
                Ok(value) => rpc_result(id, &tool_success(&value)),
                Err(message) => rpc_result(id, &tool_error(&message)),
            };
        }
        if !self.authenticated_remote
            && matches!(name, "memory_delete" | "consolidate" | "run_lifecycle")
            && !self.consume_local_confirmation(name, &arguments)
        {
            return rpc_result(id, &tool_error("confirmation required"));
        }
        let result = match name {
            "recall" => self.tool_recall(&arguments, disclosure),
            "journal_write" => self.tool_journal_write(&arguments),
            "journal_recall" => self.tool_journal_recall(&arguments),
            "journal_verify_chain" => self.tool_journal_verify(&arguments),
            "memory_stats" => self.tool_stats(&arguments, disclosure.is_some()),
            "memory_get" => self.tool_memory_get(&arguments, disclosure),
            "memory_list" => self.tool_memory_list(&arguments, disclosure),
            "memory_update" => self.tool_memory_update(&arguments, disclosure),
            "memory_delete" => self.tool_memory_delete(&arguments),
            "remember_batch" => self.tool_remember_batch(&arguments),
            "capture_event" => self.tool_capture_event(&arguments),
            "entity_lookup" => self.tool_entity_lookup(&arguments, disclosure),
            "consolidate" => self.tool_consolidate(&arguments),
            "snapshot_now" => self.tool_snapshot_now(),
            "recall_at" => self.tool_recall_at(&arguments, disclosure),
            "run_lifecycle" => self.tool_run_lifecycle(),
            "circadian_status" => self.tool_circadian_status(),
            _ => return rpc_error(id, -32602, "Unknown tool"),
        };
        match result {
            Ok(value) => {
                if let Some(change) = resource_change(name, &arguments, &value) {
                    self.notify_resource_changes(change);
                }
                rpc_result(id, &tool_success(&value))
            }
            Err(message) => rpc_result(id, &tool_error(&message)),
        }
    }

    fn list_resources(
        &self,
        id: &Value,
        params: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Value {
        let scope = match recall_scope(params) {
            Ok(scope) => scope,
            Err(error) => return rpc_error(id, -32602, &error),
        };
        let offset = match params.get("cursor").and_then(Value::as_str) {
            Some(cursor) => match cursor.parse::<usize>() {
                Ok(offset) => offset,
                Err(_) => return rpc_error(id, -32602, "Invalid resource cursor"),
            },
            None => 0,
        };
        let page = match self.engine.list_disclosed_memory_page(
            &scope,
            200,
            offset,
            disclosure.map_or(DisclosureAuthority::Agent, |context| context.authority),
            disclosure.map_or(MemoryPurpose::ConversationalContext, |context| {
                context.purpose
            }),
        ) {
            Ok(page) => page,
            Err(error) => return rpc_error(id, -32002, &error.to_string()),
        };
        let mut result = json!({
            "resources": page.memories.iter().map(|memory| json!({
                    "uri": memory_resource_uri(&memory.id, &scope),
                    "name": format!("Memory {}", memory.id),
                    "title": "Policy-safe memory",
                    "mimeType": "application/json"
                })).collect::<Vec<_>>()
        });
        if let Some(offset) = page.next_offset {
            result["nextCursor"] = Value::String(offset.to_string());
        }
        rpc_result(id, &result)
    }

    fn list_resource_templates(&self, id: &Value) -> Value {
        rpc_result(
            id,
            &json!({
                "resourceTemplates": [{
                    "uriTemplate": "celiums-memory://memories/{id}{?tenant_id,user_id,project_id,conversation_id,session_id}",
                    "name": "Policy-safe memory",
                    "mimeType": "application/json"
                }]
            }),
        )
    }

    fn read_resource(
        &self,
        id: &Value,
        params: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Value {
        let Some(uri) = params.get("uri").and_then(Value::as_str) else {
            return rpc_error(id, -32602, "Resource URI is required");
        };
        let (memory_id, arguments) = match parse_memory_resource_uri(uri) {
            Ok(parsed) => parsed,
            Err(error) => return rpc_error(id, -32602, &error),
        };
        let scope = match recall_scope(&arguments) {
            Ok(scope) => scope,
            Err(error) => return rpc_error(id, -32602, &error),
        };
        let memory =
            match self
                .engine
                .get_disclosed_memory(celiums_memory_engine::DisclosedMemoryRequest {
                    id: memory_id,
                    scope,
                    disclosure_authority: disclosure
                        .map_or(DisclosureAuthority::Agent, |context| context.authority),
                    disclosure_purpose: disclosure
                        .map_or(MemoryPurpose::ConversationalContext, |context| {
                            context.purpose
                        }),
                }) {
                Ok(Some(memory)) => memory,
                Ok(None) => return rpc_error(id, -32002, "Resource not found"),
                Err(error) => return rpc_error(id, -32002, &error.to_string()),
            };
        let text = serde_json::to_string(&json!({
            "id": memory.id,
            "content": memory.content,
            "disclosure": format!("{:?}", memory.disclosure).to_lowercase(),
            "tags": memory.tags,
            "created_at_ms": memory.created_at_ms,
            "citation": citation_json(&memory.citation),
        }))
        .unwrap_or_else(|_| "null".to_owned());
        rpc_result(
            id,
            &json!({"contents":[{"uri":uri,"mimeType":"application/json","text":text}]}),
        )
    }

    fn subscribe_resource(
        &mut self,
        id: &Value,
        params: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Value {
        let Some(uri) = params.get("uri").and_then(Value::as_str) else {
            return rpc_error(id, -32602, "Resource URI is required");
        };
        let (memory_id, arguments) = match parse_memory_resource_uri(uri) {
            Ok(parsed) => parsed,
            Err(_) => return rpc_error(id, -32602, "Invalid memory resource URI"),
        };
        if self.subscriptions.len() >= 1_000 && !self.subscriptions.contains(uri) {
            return rpc_error(id, -32002, "Subscription limit reached");
        }
        let scope = match recall_scope(&arguments) {
            Ok(scope) => scope,
            Err(error) => return rpc_error(id, -32602, &error),
        };
        match self
            .engine
            .get_disclosed_memory(celiums_memory_engine::DisclosedMemoryRequest {
                id: memory_id,
                scope,
                disclosure_authority: disclosure
                    .map_or(DisclosureAuthority::Agent, |context| context.authority),
                disclosure_purpose: disclosure
                    .map_or(MemoryPurpose::ConversationalContext, |context| {
                        context.purpose
                    }),
            }) {
            Ok(Some(_)) => {}
            Ok(None) => return rpc_error(id, -32002, "Resource not found"),
            Err(error) => return rpc_error(id, -32002, &error.to_string()),
        }
        self.subscriptions.insert(uri.to_owned());
        rpc_result(id, &json!({}))
    }

    fn unsubscribe_resource(&mut self, id: &Value, params: &Value) -> Value {
        let Some(uri) = params.get("uri").and_then(Value::as_str) else {
            return rpc_error(id, -32602, "Resource URI is required");
        };
        self.subscriptions.remove(uri);
        rpc_result(id, &json!({}))
    }

    fn notify_resource_changes(&mut self, change: ResourceChange) {
        for uri in self.subscriptions.iter().filter(|subscribed| {
            change.tenant_wide
                || change
                    .updated_uris
                    .iter()
                    .any(|changed| same_resource_uri(changed, subscribed))
        }) {
            self.pending_notifications.push_back(json!({
                "jsonrpc":"2.0",
                "method":"notifications/resources/updated",
                "params":{"uri":uri}
            }));
        }
        if change.list_changed {
            self.pending_notifications.push_back(json!({
                "jsonrpc":"2.0",
                "method":"notifications/resources/list_changed"
            }));
        }
        self.pending_resource_changes.push_back(change);
    }

    fn tool_remember_outcome(&mut self, arguments: &Value) -> Result<ToolOutcome, String> {
        let content = required_string(arguments, "content")?;
        let embedding = self.embedding_from(arguments, &content)?;
        let embedding_space = self.embedding_space_from(arguments)?;
        let now = now_ms();
        let context = remember_context(arguments, &content, now)?;
        let before_count = self.engine.count().map_err(|error| error.to_string())?;
        let memory = self
            .engine
            .remember(RememberRequest {
                content,
                embedding,
                tags: string_array(arguments, "tags"),
                scope: optional_scope(arguments)?.unwrap_or_default(),
                importance: arguments.get("importance").and_then(Value::as_f64),
                now_ms: now,
                context: Some(context),
                embedding_space: Some(embedding_space),
                idempotency_key: optional_string(arguments, "idempotency_key")?
                    .map(IdempotencyKey::new)
                    .transpose()
                    .map_err(|error| error.to_string())?,
                content_role: parse_content_role(arguments)?,
                purpose: parse_memory_purpose(arguments, "purpose")?,
            })
            .map_err(|error| error.to_string())?;
        let after_count = self.engine.count().map_err(|error| error.to_string())?;
        Ok(ToolOutcome {
            value: json!({
            "id": memory.id,
            "importance": memory.importance,
            "memory_type": memory.memory_type.as_str(),
            "valence": memory.pad.pleasure,
            "arousal": memory.pad.arousal,
            "identity": identity_json(&memory.identity),
            "provenance": provenance_json(&memory.provenance),
            "embedding_space": embedding_space_json(
                memory.embedding_space.as_ref().expect("new memory has embedding identity")
            ),
            "event_at_ms": memory.event_at_ms,
            "ingested_at_ms": memory.ingested_at_ms,
            }),
            resource_change: (after_count > before_count).then(|| ResourceChange {
                list_changed: true,
                updated_uris: BTreeSet::new(),
                tenant_wide: false,
            }),
        })
    }

    fn tool_recall(
        &mut self,
        arguments: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Result<Value, String> {
        let query = required_string(arguments, "query")?;
        let embedding = self.embedding_from(arguments, &query)?;
        let embedding_space = self.embedding_space_from(arguments)?;
        let scope = scoped_recall_scope(arguments)?;
        let limit = arguments
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_RECALL_LIMIT, |value| value as usize);
        if limit == 0 || limit > 50 {
            return Err("limit must be in 1..=50".to_owned());
        }
        let response = self
            .engine
            .recall(RecallRequest {
                query_text: query,
                embedding,
                limit,
                current_state: None,
                now_ms: now_ms(),
                scope: Some(scope),
                embedding_space: Some(embedding_space),
                disclosure_authority: disclosure_authority(arguments, disclosure)?,
                disclosure_purpose: disclosure_purpose(arguments, disclosure)?,
                options: celiums_memory_engine::RecallOptions::default(),
            })
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "results": response.results.iter().map(scored_json).collect::<Vec<_>>(),
            "semantic_abstention": response.semantic_abstention.map(abstention_str),
            "lexical_abstention": response.lexical_abstention.map(abstention_str),
            "graph_abstention": response.graph_abstention.map(abstention_str),
            "temporal_abstention": response.temporal_abstention.map(abstention_str),
            "overall_abstention": response.overall_abstention.map(|reason| format!("{reason:?}").to_lowercase()),
            "candidate_count": response.candidate_count,
            "reranker_status": format!("{:?}", response.reranker_status),
        }))
    }

    fn tool_journal_write(&mut self, arguments: &Value) -> Result<Value, String> {
        let entry_type = required_string(arguments, "entry_type")?;
        let entry_type = JournalEntryType::parse(&entry_type).ok_or(
            "entry_type must be one of reflection|decision|lesson|belief|emotion|arc|doubt",
        )?;
        let entry = self
            .engine
            .journal_write(JournalWriteRequest {
                agent_id: required_string(arguments, "agent_id")?,
                entry_type,
                content: required_string(arguments, "content")?,
                preceded_by: string_array(arguments, "preceded_by"),
                valence: arguments.get("valence").and_then(Value::as_f64),
                valence_reason: arguments
                    .get("valence_reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                tags: string_array(arguments, "tags"),
                conversation_id: arguments
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                now_ms: now_ms(),
            })
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "id": entry.id,
            "hash": entry.hash,
            "prev_hash": entry.prev_hash,
            "importance": entry.importance,
        }))
    }

    fn tool_journal_recall(&mut self, arguments: &Value) -> Result<Value, String> {
        let entry_type = match arguments.get("entry_type").and_then(Value::as_str) {
            Some(raw) => Some(JournalEntryType::parse(raw).ok_or("invalid entry_type")?),
            None => None,
        };
        let entries = self
            .engine
            .journal_recall(&JournalRecallRequest {
                agent_id: required_string(arguments, "agent_id")?,
                query: arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                entry_type,
                limit: arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map_or(DEFAULT_RECALL_LIMIT, |value| value.max(1) as usize),
                include_superseded: arguments
                    .get("include_superseded")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "entries": entries.iter().map(|entry| json!({
                "id": entry.id,
                "entry_type": entry.entry_type.as_str(),
                "content": entry.content,
                "valence": entry.valence,
                "tags": entry.tags,
                "written_at_ms": entry.written_at_ms,
            })).collect::<Vec<_>>(),
        }))
    }

    fn tool_journal_verify(&mut self, arguments: &Value) -> Result<Value, String> {
        let report = self
            .engine
            .journal_verify_chain(&required_string(arguments, "agent_id")?)
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "agent_id": report.agent_id,
            "total": report.total,
            "valid": report.valid,
            "broken": report.broken.iter().map(|link| json!({
                "entry_id": link.entry_id,
                "reason": format!("{:?}", link.reason),
            })).collect::<Vec<_>>(),
        }))
    }

    fn tool_stats(&mut self, arguments: &Value, authenticated: bool) -> Result<Value, String> {
        if authenticated {
            let count = self
                .engine
                .count_visible(&scoped_recall_scope(arguments)?)
                .map_err(|error| error.to_string())?;
            return Ok(json!({"memories":count,"affect":Value::Null}));
        }
        let count = self.engine.count().map_err(|error| error.to_string())?;
        let state = self.engine.affect_state(now_ms());
        Ok(json!({"memories":count,"affect":{
            "pleasure":state.pleasure,
            "arousal":state.arousal,
            "dominance":state.dominance,
            "label":celiums_cognition::emotion_label(state),
        }}))
    }

    fn tool_memory_get(
        &self,
        arguments: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Result<Value, String> {
        let memory = self
            .engine
            .get_disclosed_memory(celiums_memory_engine::DisclosedMemoryRequest {
                id: required_string(arguments, "id")?,
                scope: scoped_recall_scope(arguments)?,
                disclosure_authority: disclosure_authority(arguments, disclosure)?,
                disclosure_purpose: disclosure_purpose(arguments, disclosure)?,
            })
            .map_err(|error| error.to_string())?;
        match memory {
            Some(memory) => Ok(json!({"memory":hydrated_json(&memory)})),
            None if self.authenticated_remote => Err("resource not found".to_owned()),
            None => Ok(json!({"memory":Value::Null})),
        }
    }

    fn tool_memory_list(
        &self,
        arguments: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Result<Value, String> {
        let scope = scoped_recall_scope(arguments)?;
        let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
        let page = self
            .engine
            .list_disclosed_memory_page(
                &scope,
                limit,
                0,
                disclosure_authority(arguments, disclosure)?,
                disclosure_purpose(arguments, disclosure)?,
            )
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "memories": page.memories.iter().map(hydrated_json).collect::<Vec<_>>(),
            "matched": self.engine.count_visible(&scope).map_err(|error| error.to_string())?,
        }))
    }

    fn tool_memory_update(
        &mut self,
        arguments: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Result<Value, String> {
        let scope = scoped_recall_scope(arguments)?;
        let authority = disclosure_authority(arguments, disclosure)?;
        let purpose = disclosure_purpose(arguments, disclosure)?;
        let patch_value = arguments.get("patch").ok_or("`patch` is required")?;
        let patch = MemoryPatch {
            importance: patch_value.get("importance").and_then(Value::as_f64),
            state: patch_value
                .get("state")
                .and_then(Value::as_str)
                .and_then(celiums_cognition::MemoryState::parse),
            scope: patch_value
                .get("scope")
                .and_then(Value::as_str)
                .and_then(Scope::parse),
            tags: patch_value
                .get("tags")
                .map(|_| string_array(patch_value, "tags")),
            event_at_ms: patch_value.get("event_at_ms").map(Value::as_i64),
        };
        let memory = self
            .engine
            .update_memory(UpdateMemoryRequest {
                id: required_string(arguments, "id")?,
                scope: scope.clone(),
                patch,
                if_revision: arguments
                    .get("if_revision")
                    .and_then(Value::as_u64)
                    .ok_or("`if_revision` is required")?,
                now_ms: now_ms(),
            })
            .map_err(|error| error.to_string())?;
        let Some(memory) = memory else {
            return if self.authenticated_remote {
                Err("resource not found".to_owned())
            } else {
                Ok(json!({"memory":Value::Null}))
            };
        };
        let disclosed = self
            .engine
            .get_disclosed_memory(celiums_memory_engine::DisclosedMemoryRequest {
                id: memory.id.clone(),
                scope,
                disclosure_authority: authority,
                disclosure_purpose: purpose,
            })
            .ok()
            .flatten();
        Ok(json!({
            "id":memory.id,
            "revision":memory.revision,
            "memory":disclosed.as_ref().map(hydrated_json)
        }))
    }

    fn tool_memory_delete(&mut self, arguments: &Value) -> Result<Value, String> {
        let outcome = self
            .engine
            .delete_memory(
                &required_string(arguments, "id")?,
                &scoped_recall_scope(arguments)?,
            )
            .map_err(|error| error.to_string())?;
        if self.authenticated_remote && !outcome.deleted {
            return Err("resource not found".to_owned());
        }
        Ok(json!({ "id": outcome.id, "deleted": outcome.deleted }))
    }

    fn tool_confirm_destructive(&mut self, arguments: &Value) -> Result<Value, String> {
        let operation = required_string(arguments, "operation")?;
        if !matches!(
            operation.as_str(),
            "memory_delete" | "consolidate" | "run_lifecycle"
        ) {
            return Err("invalid confirmation operation".to_owned());
        }
        let resource_id = required_string(arguments, "resource_id")?;
        let token = Uuid::now_v7().to_string();
        self.confirmations
            .retain(|_, value| value.expires_at >= Instant::now());
        self.confirmations.insert(
            token.clone(),
            LocalConfirmation {
                operation,
                resource_id,
                expires_at: Instant::now() + Duration::from_secs(5 * 60),
            },
        );
        Ok(json!({"confirmation_token":token,"expires_in_seconds":300}))
    }

    fn consume_local_confirmation(&mut self, operation: &str, arguments: &Value) -> bool {
        let resource_id = arguments
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("tenant");
        let Some(token) = arguments.get("confirmation_token").and_then(Value::as_str) else {
            return false;
        };
        let Some(confirmation) = self.confirmations.remove(token) else {
            return false;
        };
        confirmation.expires_at >= Instant::now()
            && confirmation.operation == operation
            && confirmation.resource_id == resource_id
    }

    fn tool_remember_batch(&mut self, arguments: &Value) -> Result<Value, String> {
        let items = arguments
            .get("items")
            .and_then(Value::as_array)
            .ok_or("`items` is required")?;
        if items.len() > 100 {
            return Err("remember batch maximum is 100 items".to_owned());
        }
        let before_count = self.engine.count().map_err(|error| error.to_string())?;
        let mut requests = Vec::with_capacity(items.len());
        for item in items {
            let content = required_string(item, "content")?;
            requests.push(RememberRequest {
                embedding: self.embedding_from(item, &content)?,
                embedding_space: Some(self.embedding_space_from(item)?),
                context: Some(remember_context(item, &content, now_ms())?),
                idempotency_key: optional_string(item, "idempotency_key")?
                    .map(IdempotencyKey::new)
                    .transpose()
                    .map_err(|error| error.to_string())?,
                content_role: parse_content_role(item)?,
                purpose: parse_memory_purpose(item, "purpose")?,
                content,
                tags: string_array(item, "tags"),
                scope: optional_scope(item)?.unwrap_or_default(),
                importance: item.get("importance").and_then(Value::as_f64),
                now_ms: now_ms(),
            });
        }
        let outcomes = self.engine.remember_batch(requests);
        let after_count = self.engine.count().map_err(|error| error.to_string())?;
        Ok(json!({
            "created":after_count.saturating_sub(before_count),
            "results": outcomes.into_iter().map(|outcome| match outcome.result {
                Ok(memory) => json!({"index": outcome.index, "id": memory.id}),
                Err(error) => json!({"index": outcome.index, "error": error}),
            }).collect::<Vec<_>>()
        }))
    }

    fn tool_capture_event(&mut self, arguments: &Value) -> Result<Value, String> {
        let content = required_string(arguments, "content")?;
        let embedding = self.embedding_from(arguments, &content)?;
        let adapter = parse_capture_adapter(arguments)?;
        let now = now_ms();
        let context = remember_context(arguments, &content, now)?;
        let before_count = self.engine.count().map_err(|error| error.to_string())?;
        let entry = self
            .engine
            .ingest_event(
                CaptureEvent {
                    adapter,
                    source_event_id: SourceEventId::new(required_string(
                        arguments,
                        "source_event_id",
                    )?)
                    .map_err(|error| error.to_string())?,
                    turn_id: optional_string(arguments, "turn_id")?
                        .map(TurnId::new)
                        .transpose()
                        .map_err(|error| error.to_string())?,
                    source_kind: context.provenance.source_kind,
                    source_uri: context.provenance.source_uri,
                    actor: context.provenance.actor,
                    identity: context.identity,
                    content,
                    event_at_ms: context.event_at_ms,
                    ingested_at_ms: now,
                    embedding: Some(embedding),
                    tags: string_array(arguments, "tags"),
                    scope: optional_scope(arguments)?.unwrap_or_default(),
                    content_role: parse_content_role(arguments)?,
                    purpose: parse_memory_purpose(arguments, "purpose")?,
                }
                .into_ingest_request(),
            )
            .map_err(|error| error.to_string())?;
        let after_count = self.engine.count().map_err(|error| error.to_string())?;
        let mut result = ingestion_json(&entry);
        result["materialized_now"] = Value::Bool(after_count > before_count);
        Ok(result)
    }

    fn tool_entity_lookup(
        &mut self,
        arguments: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Result<Value, String> {
        match arguments.get("name").and_then(Value::as_str) {
            Some(name) => {
                let kind = arguments
                    .get("entity_kind")
                    .and_then(Value::as_str)
                    .and_then(EntityKind::parse)
                    .ok_or("entity_kind must be one of person|technology|project")?;
                let memories = self
                    .engine
                    .entity_memories_scoped(
                        kind,
                        name,
                        &scoped_recall_scope(arguments)?,
                        disclosure_authority(arguments, disclosure)?,
                        disclosure_purpose(arguments, disclosure)?,
                    )
                    .map_err(|error| error.to_string())?;
                Ok(json!({
                    "memories": memories.iter().map(|view| json!({
                        "id": view.memory.id,
                        "content": view.disclosed_content,
                        "disclosure": format!("{:?}", view.disclosure).to_lowercase(),
                        "importance": view.memory.importance,
                    })).collect::<Vec<_>>(),
                }))
            }
            None => {
                let scope = scoped_recall_scope(arguments)?;
                let mut entities = Vec::new();
                for entity in self.engine.entities().map_err(|error| error.to_string())? {
                    let visible = self
                        .engine
                        .entity_memories_scoped(
                            entity.kind,
                            &entity.name,
                            &scope,
                            disclosure_authority(arguments, disclosure)?,
                            disclosure_purpose(arguments, disclosure)?,
                        )
                        .map_err(|error| error.to_string())?;
                    if !visible.is_empty() {
                        entities.push((entity, visible.len()));
                    }
                }
                Ok(json!({
                    "entities": entities.iter().map(|(entity, visible_count)| json!({
                        "name": entity.name,
                        "entity_kind": entity.kind.as_str(),
                        "salience": entity.salience,
                        "memory_count": visible_count,
                    })).collect::<Vec<_>>(),
                }))
            }
        }
    }

    fn tool_consolidate(&mut self, arguments: &Value) -> Result<Value, String> {
        let report = self
            .engine
            .consolidate(&required_string(arguments, "text")?, now_ms())
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "created": report.created,
            "merged": report.merged,
            "skipped": report.skipped,
        }))
    }

    fn tool_snapshot_now(&mut self) -> Result<Value, String> {
        let point = self.engine.snapshot().map_err(|error| error.to_string())?;
        Ok(json!({
            "checkpoint_sequence": point.checkpoint_sequence,
            "path": point.path.display().to_string(),
        }))
    }

    fn tool_recall_at(
        &mut self,
        arguments: &Value,
        disclosure: Option<DisclosureContext>,
    ) -> Result<Value, String> {
        let query = required_string(arguments, "query")?;
        let embedding = self.embedding_from(arguments, &query)?;
        let points = snapshot_points(&self.data_dir).map_err(|error| error.to_string())?;
        let point = match arguments.get("checkpoint_sequence").and_then(Value::as_u64) {
            Some(sequence) => points
                .into_iter()
                .find(|point| point.checkpoint_sequence == sequence)
                .ok_or_else(|| format!("no snapshot with checkpoint_sequence {sequence}"))?,
            None => points
                .into_iter()
                .next_back()
                .ok_or("no snapshots exist yet; call snapshot_now first")?,
        };
        let response = recall_at(
            &point.path,
            &RecallConfig::default(),
            &RecallRequest {
                query_text: query,
                embedding,
                limit: arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map_or(DEFAULT_RECALL_LIMIT, |value| value.max(1) as usize),
                current_state: None,
                now_ms: now_ms(),
                scope: Some(scoped_recall_scope(arguments)?),
                embedding_space: Some(self.embedding_space_from(arguments)?),
                disclosure_authority: disclosure_authority(arguments, disclosure)?,
                disclosure_purpose: disclosure_purpose(arguments, disclosure)?,
                options: snapshot_recall_options(),
            },
        )
        .map_err(|error| error.to_string())?;
        Ok(json!({
            "checkpoint_sequence": point.checkpoint_sequence,
            "results": response.results.iter().map(scored_json).collect::<Vec<_>>(),
            "semantic_abstention": response.semantic_abstention.map(abstention_str),
            "lexical_abstention": response.lexical_abstention.map(abstention_str),
        }))
    }

    fn tool_run_lifecycle(&mut self) -> Result<Value, String> {
        let report = self
            .engine
            .run_lifecycle(now_ms())
            .map_err(|error| error.to_string())?;
        Ok(json!({ "decayed": report.decayed, "archived": report.archived }))
    }

    fn tool_circadian_status(&mut self) -> Result<Value, String> {
        let status = self.engine.circadian_status(now_ms());
        Ok(json!({
            "offset_minutes": status.offset_minutes,
            "source": status.source,
            "local_hour": status.local_hour,
            "time_of_day": status.time_of_day,
            "factors": {
                "session_activity": status.factors.session_activity,
                "stress": status.factors.stress_level,
                "caffeine": status.factors.caffeine_level,
                "sleep_debt": status.factors.sleep_debt,
                "cognitive_load": status.factors.cognitive_load,
                "motivation": status.factors.motivation_trend,
            },
            "rhythm": {
                "inferred_offset_minutes": status.rhythm.offset_minutes,
                "confidence": status.rhythm.confidence,
                "samples": status.rhythm.samples,
            },
        }))
    }

    /// The caller's embedding when provided, the deterministic offline
    /// embedder otherwise.
    fn embedding_from(&self, arguments: &Value, text: &str) -> Result<Vec<f32>, String> {
        match arguments.get("embedding") {
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    value
                        .as_f64()
                        .map(|component| component as f32)
                        .ok_or_else(|| "embedding components must be numbers".to_owned())
                })
                .collect(),
            Some(_) => Err("embedding must be an array of numbers".to_owned()),
            None => Ok(deterministic_embed(text, self.dimension)),
        }
    }

    fn embedding_space_from(&self, arguments: &Value) -> Result<EmbeddingSpaceIdentity, String> {
        let configured = self.engine.embedding_space();
        EmbeddingSpaceIdentity::new(
            arguments
                .get("embedding_provider")
                .and_then(Value::as_str)
                .unwrap_or(&configured.provider),
            arguments
                .get("embedding_model")
                .and_then(Value::as_str)
                .unwrap_or(&configured.model),
            arguments
                .get("embedding_revision")
                .and_then(Value::as_str)
                .unwrap_or(&configured.revision),
            self.dimension,
            EmbeddingNormalization::L2,
        )
        .map_err(|error| error.to_string())
    }
}

fn inject_local_identity(message: &mut Value, tenant_id: &TenantId) {
    let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) else {
        return;
    };
    params.insert("tenant_id".to_owned(), Value::String(tenant_id.to_string()));
    if let Some(uri) = params.get("uri").and_then(Value::as_str).map(str::to_owned) {
        let (base, query) = uri.split_once('?').unwrap_or((&uri, ""));
        let mut pairs = query
            .split('&')
            .filter(|pair| !pair.is_empty() && !pair.starts_with("tenant_id="))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        pairs.insert(0, format!("tenant_id={}", uri_encode(tenant_id.as_str())));
        params.insert(
            "uri".to_owned(),
            Value::String(format!("{base}?{}", pairs.join("&"))),
        );
    }
    if let Some(arguments) = params.get_mut("arguments").and_then(Value::as_object_mut) {
        arguments.insert("tenant_id".to_owned(), Value::String(tenant_id.to_string()));
        if let Some(items) = arguments.get_mut("items").and_then(Value::as_array_mut) {
            for item in items.iter_mut().filter_map(Value::as_object_mut) {
                item.insert("tenant_id".to_owned(), Value::String(tenant_id.to_string()));
            }
        }
    }
}

fn same_resource_uri(left: &str, right: &str) -> bool {
    left.split_once('?').map_or(left, |(base, _)| base)
        == right.split_once('?').map_or(right, |(base, _)| base)
}

fn scored_json(scored: &ScoredMemory) -> Value {
    json!({
        "id": scored.memory.id,
        "content": scored.disclosed_content,
        "disclosure": format!("{:?}", scored.disclosure).to_lowercase(),
        "score": scored.final_score,
        "importance": scored.memory.importance,
        "memory_type": scored.memory.memory_type.as_str(),
        "tags": scored.memory.tags,
        "event_at_ms": scored.memory.event_at_ms,
        "ingested_at_ms": scored.memory.ingested_at_ms,
        "channels": {
            "semantic": scored.channels.semantic,
            "text_match": scored.channels.text_match,
            "importance": scored.channels.importance,
            "retrievability": scored.channels.retrievability,
            "emotional": scored.channels.emotional,
            "resonance": scored.channels.resonance,
        },
        "branches": scored.branches.iter().map(|branch| format!("{branch:?}").to_lowercase()).collect::<Vec<_>>(),
        "why_recalled": scored.why_recalled.iter().map(|reason| json!({
            "branch": format!("{:?}", reason.branch).to_lowercase(),
            "score": reason.score,
            "detail": reason.detail,
        })).collect::<Vec<_>>(),
        "citations": scored.citations.iter().map(citation_json).collect::<Vec<_>>(),
    })
}

fn citation_json(citation: &celiums_memory_engine::Citation) -> Value {
    json!({
        "memory_id": citation.memory_id,
        "source_id": Value::Null,
        "source_uri": Value::Null,
        "event_id": citation.event_id,
        "content_hash": citation.content_hash,
        "claim_ids": citation.claim_ids,
        "graph_path": citation.graph_path,
    })
}

fn resource_change(name: &str, arguments: &Value, result: &Value) -> Option<ResourceChange> {
    let scope = scoped_recall_scope(arguments).ok();
    match name {
        "remember" => resource_list_change(),
        "remember_batch" if result.get("created").and_then(Value::as_u64).unwrap_or(0) > 0 => {
            resource_list_change()
        }
        "capture_event"
            if result.get("materialized_now").and_then(Value::as_bool) == Some(true) =>
        {
            resource_list_change()
        }
        "memory_update" => result.get("id").and_then(Value::as_str).and_then(|id| {
            scope.map(|scope| {
                if mcp_update_changes_membership(arguments) {
                    ResourceChange {
                        list_changed: true,
                        updated_uris: BTreeSet::from([memory_resource_uri(id, &scope)]),
                        tenant_wide: false,
                    }
                } else {
                    updated_resource(id, &scope)
                }
            })
        }),
        "memory_delete" if result.get("deleted").and_then(Value::as_bool) == Some(true) => {
            resource_list_change()
        }
        "consolidate" if result.get("created").and_then(Value::as_u64).unwrap_or(0) > 0 => {
            resource_list_change()
        }
        "run_lifecycle"
            if result.get("decayed").and_then(Value::as_u64).unwrap_or(0) > 0
                || result.get("archived").and_then(Value::as_u64).unwrap_or(0) > 0 =>
        {
            Some(ResourceChange {
                list_changed: result.get("archived").and_then(Value::as_u64).unwrap_or(0) > 0,
                updated_uris: BTreeSet::new(),
                tenant_wide: true,
            })
        }
        _ => None,
    }
}

fn mcp_update_changes_membership(arguments: &Value) -> bool {
    arguments
        .get("patch")
        .is_some_and(|patch| patch.get("state").is_some() || patch.get("scope").is_some())
}

fn resource_list_change() -> Option<ResourceChange> {
    Some(ResourceChange {
        list_changed: true,
        updated_uris: BTreeSet::new(),
        tenant_wide: false,
    })
}

fn updated_resource(id: &str, scope: &RecallScope) -> ResourceChange {
    ResourceChange {
        list_changed: false,
        updated_uris: BTreeSet::from([memory_resource_uri(id, scope)]),
        tenant_wide: false,
    }
}

fn memory_resource_uri(id: &str, scope: &RecallScope) -> String {
    let mut parameters = vec![
        format!("tenant_id={}", uri_encode(scope.tenant_id.as_str())),
        format!("user_id={}", uri_encode(scope.user_id.as_str())),
    ];
    for (name, value) in [
        (
            "project_id",
            scope.project_id.as_ref().map(ProjectId::as_str),
        ),
        (
            "conversation_id",
            scope.conversation_id.as_ref().map(ConversationId::as_str),
        ),
        (
            "session_id",
            scope.session_id.as_ref().map(SessionId::as_str),
        ),
    ] {
        if let Some(value) = value {
            parameters.push(format!("{name}={}", uri_encode(value)));
        }
    }
    format!("celiums-memory://memories/{id}?{}", parameters.join("&"))
}

fn parse_memory_resource_uri(uri: &str) -> Result<(String, Value), String> {
    let Some(rest) = uri.strip_prefix("celiums-memory://memories/") else {
        return Err("unsupported resource URI".to_owned());
    };
    let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
    if id.is_empty() || id.contains('/') {
        return Err("invalid memory resource ID".to_owned());
    }
    let mut arguments = serde_json::Map::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair
            .split_once('=')
            .ok_or("invalid resource query parameter")?;
        if !matches!(
            key,
            "tenant_id" | "user_id" | "project_id" | "conversation_id" | "session_id"
        ) || value.is_empty()
        {
            return Err("invalid resource query parameter".to_owned());
        }
        let decoded = percent_decode_str(value)
            .decode_utf8()
            .map_err(|_| "invalid resource query encoding")?;
        arguments.insert(key.to_owned(), Value::String(decoded.into_owned()));
    }
    Ok((id.to_owned(), Value::Object(arguments)))
}

fn uri_encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn hydrated_json(memory: &celiums_memory_engine::HydratedMemory) -> Value {
    json!({
        "id": memory.id,
        "revision": memory.revision,
        "content": memory.content,
        "disclosure": format!("{:?}", memory.disclosure).to_lowercase(),
        "tags": memory.tags,
        "importance": memory.importance,
        "memory_type": memory.memory_type.as_str(),
        "created_at_ms": memory.created_at_ms,
        "citation": citation_json(&memory.citation),
    })
}

fn abstention_str(reason: BranchAbstention) -> &'static str {
    match reason {
        BranchAbstention::NoCandidates => "no_candidates",
        BranchAbstention::BelowThreshold => "below_threshold",
        BranchAbstention::Ambiguous => "ambiguous",
        BranchAbstention::Disabled => "disabled",
    }
}

fn ingestion_json(entry: &celiums_memory_engine::IngestionEntry) -> Value {
    json!({
        "event_id": entry.event_id.as_str(),
        "source_namespace": entry.source_namespace.as_str(),
        "source_event_id": entry.source_event_id.as_str(),
        "turn_id": entry.turn_id.as_ref().map(TurnId::as_str),
        "status": entry.status.as_str(),
        "memory_id": entry.memory_id,
        "error_code": entry.error_code,
        "attempt_count": entry.attempt_count,
        "conflict_count": entry.conflict_count,
    })
}

fn tool_definitions() -> Vec<Value> {
    let text_schema = |description: &str| {
        json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": description },
                "embedding": { "type": "array", "items": { "type": "number" } },
                "tags": { "type": "array", "items": { "type": "string" } },
                "scope": { "type": "string", "enum": ["session", "project", "global"] },
                "importance": { "type": "number", "minimum": 0, "maximum": 1 },
                "tenant_id": { "type": "string" },
                "user_id": { "type": "string" },
                "agent_id": { "type": "string" },
                "project_id": { "type": "string" },
                "conversation_id": { "type": "string" },
                "session_id": { "type": "string" },
                "source_kind": { "type": "string", "enum": ["user","assistant","tool","document","system","benchmark","legacy"] },
                "source_id": { "type": "string" },
                "source_uri": { "type": "string" },
                "actor": { "type": "string" },
                "event_at_ms": { "type": "integer" }
                ,"embedding_provider": { "type": "string" }
                ,"embedding_model": { "type": "string" }
                ,"embedding_revision": { "type": "string" }
                ,"idempotency_key": { "type": "string", "minLength": 1, "maxLength": 255 }
                ,"content_role": { "type": "string", "enum": ["observation","description","operational_request"] }
                ,"purpose": { "type": "string", "enum": ["conversational_context","personalization","task_execution","safety_audit"] }
            },
            "required": ["content"]
        })
    };
    vec![
        tool(
            "remember",
            "Store one memory. Importance, affect and type are classified from the content.",
            &text_schema("Text to remember"),
            false,
        ),
        tool(
            "recall",
            "Recall memories for a query: hybrid retrieval re-ranked by the cognitive formula.",
            &json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "embedding": { "type": "array", "items": { "type": "number" } },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                    "tenant_id": { "type": "string" },
                    "user_id": { "type": "string" },
                    "project_id": { "type": "string" },
                    "conversation_id": { "type": "string" },
                    "session_id": { "type": "string" }
                    ,"embedding_provider": { "type": "string" }
                    ,"embedding_model": { "type": "string" }
                    ,"embedding_revision": { "type": "string" }
                    ,"disclosure_authority": { "type": "string", "enum": ["owner","agent","auditor","third_party"] }
                    ,"disclosure_purpose": { "type": "string", "enum": ["conversational_context","personalization","task_execution","safety_audit"] }
                },
                "required": ["query"]
            }),
            true,
        ),
        tool(
            "memory_get",
            "Get one visible memory by ID without reactivation.",
            &scoped_id_schema(),
            true,
        ),
        tool(
            "memory_list",
            "List visible policy-safe memories, newest first.",
            &scope_schema(true),
            true,
        ),
        tool(
            "memory_update",
            "Optimistically update mutable memory metadata.",
            &json!({
                "type": "object",
                "properties": {
                    "id": {"type":"string"},
                    "if_revision": {"type":"integer","minimum":1},
                    "tenant_id": {"type":"string"}, "user_id": {"type":"string"},
                    "project_id": {"type":"string"}, "conversation_id": {"type":"string"},
                    "session_id": {"type":"string"},
                    "patch": {
                        "type":"object",
                        "properties": {
                            "importance":{"type":"number","minimum":0,"maximum":1},
                            "state":{"type":"string","enum":["active","consolidated","archived"]},
                            "scope":{"type":"string","enum":["session","project","global"]},
                            "tags":{"type":"array","items":{"type":"string"}},
                            "event_at_ms":{"type":["integer","null"]}
                        }
                    }
                },
                "required":["id","if_revision","patch"]
            }),
            false,
        ),
        tool(
            "memory_delete",
            "Hard-delete one visible memory and its vector/entity projections.",
            &{
                let mut schema = scoped_id_schema();
                schema["properties"]["confirmation_token"] = json!({"type":"string"});
                schema
            },
            false,
        ),
        tool(
            "confirm_destructive",
            "Issue a short-lived one-use confirmation for a destructive local MCP operation.",
            &json!({
                "type":"object",
                "properties":{
                    "operation":{"type":"string","enum":["memory_delete","consolidate","run_lifecycle"]},
                    "resource_id":{"type":"string"}
                },
                "required":["operation","resource_id"],
                "additionalProperties":false
            }),
            true,
        ),
        tool(
            "remember_batch",
            "Store up to 100 memories with independent per-item outcomes.",
            &json!({
                "type":"object",
                "properties":{"items":{"type":"array","maxItems":100,"items":text_schema("Text to remember")}},
                "required":["items"]
            }),
            false,
        ),
        tool(
            "capture_event",
            "Capture one raw coding-agent, MCP, or webhook event with durable provenance.",
            &json!({
                "type":"object",
                "properties": {
                    "adapter":{"type":"string","enum":["opencode_codex","claude_code","cursor","mcp","webhook"]},
                    "source_event_id":{"type":"string","minLength":1,"maxLength":255},
                    "turn_id":{"type":"string","minLength":1,"maxLength":255},
                    "content":{"type":"string"},
                    "embedding":{"type":"array","items":{"type":"number"}},
                    "tags":{"type":"array","items":{"type":"string"}},
                    "scope":{"type":"string","enum":["session","project","global"]},
                    "tenant_id":{"type":"string"},"user_id":{"type":"string"},
                    "agent_id":{"type":"string"},"project_id":{"type":"string"},
                    "conversation_id":{"type":"string"},"session_id":{"type":"string"},
                    "source_kind":{"type":"string","enum":["user","assistant","tool","document","system","benchmark","legacy"]},
                    "source_uri":{"type":"string"},"actor":{"type":"string"},
                    "event_at_ms":{"type":"integer"},
                    "content_role":{"type":"string","enum":["observation","description","operational_request"]},
                    "purpose":{"type":"string","enum":["conversational_context","personalization","task_execution","safety_audit"]}
                },
                "required":["adapter","source_event_id","content"]
            }),
            false,
        ),
        tool(
            "journal_write",
            "Write one first-person journal entry, hash-chained per agent.",
            &json!({
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string" },
                    "entry_type": { "type": "string",
                        "enum": ["reflection","decision","lesson","belief","emotion","arc","doubt"] },
                    "content": { "type": "string" },
                    "preceded_by": { "type": "array", "items": { "type": "string" } },
                    "valence": { "type": "number", "minimum": -1, "maximum": 1 },
                    "valence_reason": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "conversation_id": { "type": "string" }
                },
                "required": ["agent_id", "entry_type", "content"]
            }),
            false,
        ),
        tool(
            "journal_recall",
            "Recall one agent's journal entries, newest first, excluding superseded by default.",
            &json!({
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string" },
                    "query": { "type": "string" },
                    "entry_type": { "type": "string",
                        "enum": ["reflection","decision","lesson","belief","emotion","arc","doubt"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                    "include_superseded": { "type": "boolean" }
                },
                "required": ["agent_id"]
            }),
            true,
        ),
        tool(
            "journal_verify_chain",
            "Recompute one agent's journal hash chain and report tampering.",
            &json!({
                "type": "object",
                "properties": { "agent_id": { "type": "string" } },
                "required": ["agent_id"]
            }),
            true,
        ),
        tool(
            "memory_stats",
            "Memory count and the engine's current affective state.",
            &json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            true,
        ),
        tool(
            "entity_lookup",
            "List indexed entities, or the memories bound to one entity (the memory graph).",
            &json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "entity_kind": { "type": "string", "enum": ["person","technology","project"] },
                    "tenant_id": { "type": "string" }, "user_id": { "type": "string" },
                    "project_id": { "type": "string" }, "conversation_id": { "type": "string" },
                    "session_id": { "type": "string" }
                }
            }),
            true,
        ),
        tool(
            "consolidate",
            "Distil conversation text into memories: new when novel, merged when duplicate (cosine >= 0.92).",
            &json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
            false,
        ),
        tool(
            "snapshot_now",
            "Create a verified time-travel point of the current state.",
            &json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            false,
        ),
        tool(
            "recall_at",
            "Recall from a past snapshot: what the agent knew then. Read-only, cryptographically verified.",
            &json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "checkpoint_sequence": { "type": "integer" },
                    "embedding": { "type": "array", "items": { "type": "number" } },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                    "tenant_id": { "type": "string" },
                    "user_id": { "type": "string" },
                    "project_id": { "type": "string" },
                    "conversation_id": { "type": "string" },
                    "session_id": { "type": "string" }
                    ,"embedding_provider": { "type": "string" }
                    ,"embedding_model": { "type": "string" }
                    ,"embedding_revision": { "type": "string" }
                },
                "required": ["query"]
            }),
            true,
        ),
        tool(
            "run_lifecycle",
            "Apply lifecycle decay: idle memories lose importance; below 0.05 they archive.",
            &json!({
                "type":"object",
                "properties":{"confirmation_token":{"type":"string"}},
                "additionalProperties":false
            }),
            false,
        ),
        tool(
            "circadian_status",
            "The engine's biological clock: effective timezone (override/inferred/UTC), local hour, day phase, physiological factors.",
            &json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            true,
        ),
    ]
}

fn scope_schema(include_limit: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([
        ("tenant_id".to_owned(), json!({"type":"string"})),
        ("user_id".to_owned(), json!({"type":"string"})),
        ("project_id".to_owned(), json!({"type":"string"})),
        ("conversation_id".to_owned(), json!({"type":"string"})),
        ("session_id".to_owned(), json!({"type":"string"})),
    ]);
    if include_limit {
        properties.insert(
            "limit".to_owned(),
            json!({"type":"integer","minimum":1,"maximum":200}),
        );
    }
    json!({"type":"object","properties":properties})
}

fn scoped_id_schema() -> Value {
    let mut schema = scope_schema(false);
    schema["properties"]["id"] = json!({"type":"string"});
    schema["required"] = json!(["id"]);
    schema
}

fn tool(name: &str, description: &str, input_schema: &Value, read_only: bool) -> Value {
    let destructive = name == "memory_delete";
    let idempotent = matches!(
        name,
        "memory_delete" | "memory_get" | "memory_list" | "recall"
    );
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": false
        }
    })
}

fn required_string(arguments: &Value, field: &str) -> Result<String, String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("`{field}` is required"))
}

fn optional_scope(arguments: &Value) -> Result<Option<Scope>, String> {
    match arguments.get("scope") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Scope::parse(value)
            .map(Some)
            .ok_or_else(|| "scope must be session|project|global".to_owned()),
        Some(_) => Err("scope must be a string".to_owned()),
    }
}

fn parse_content_role(arguments: &Value) -> Result<celiums_cognition::ContentRole, String> {
    match arguments.get("content_role").and_then(Value::as_str) {
        None | Some("observation") => Ok(celiums_cognition::ContentRole::Observation),
        Some("description") => Ok(celiums_cognition::ContentRole::Description),
        Some("operational_request") => Ok(celiums_cognition::ContentRole::OperationalRequest),
        Some(_) => {
            Err("content_role must be observation|description|operational_request".to_owned())
        }
    }
}

fn parse_memory_purpose(
    arguments: &Value,
    field: &str,
) -> Result<celiums_cognition::MemoryPurpose, String> {
    match arguments.get(field).and_then(Value::as_str) {
        None | Some("conversational_context") => {
            Ok(celiums_cognition::MemoryPurpose::ConversationalContext)
        }
        Some("personalization") => Ok(celiums_cognition::MemoryPurpose::Personalization),
        Some("task_execution") => Ok(celiums_cognition::MemoryPurpose::TaskExecution),
        Some("safety_audit") => Ok(celiums_cognition::MemoryPurpose::SafetyAudit),
        Some(_) => Err(format!(
            "{field} must be conversational_context|personalization|task_execution|safety_audit"
        )),
    }
}

fn parse_disclosure_authority(
    arguments: &Value,
) -> Result<celiums_cognition::DisclosureAuthority, String> {
    match arguments
        .get("disclosure_authority")
        .and_then(Value::as_str)
    {
        None | Some("agent") => Ok(celiums_cognition::DisclosureAuthority::Agent),
        Some("owner") => Ok(celiums_cognition::DisclosureAuthority::Owner),
        Some("auditor") => Ok(celiums_cognition::DisclosureAuthority::Auditor),
        Some("third_party") => Ok(celiums_cognition::DisclosureAuthority::ThirdParty),
        Some(_) => Err("disclosure_authority must be owner|agent|auditor|third_party".to_owned()),
    }
}

fn session_disclosure_authority(
    arguments: &Value,
) -> Result<celiums_cognition::DisclosureAuthority, String> {
    match parse_disclosure_authority(arguments)? {
        celiums_cognition::DisclosureAuthority::Agent => {
            Ok(celiums_cognition::DisclosureAuthority::Agent)
        }
        celiums_cognition::DisclosureAuthority::ThirdParty => {
            Ok(celiums_cognition::DisclosureAuthority::ThirdParty)
        }
        celiums_cognition::DisclosureAuthority::Owner
        | celiums_cognition::DisclosureAuthority::Auditor => {
            Err("stdio MCP session cannot elevate disclosure authority".to_owned())
        }
    }
}

fn disclosure_authority(
    arguments: &Value,
    authenticated: Option<DisclosureContext>,
) -> Result<DisclosureAuthority, String> {
    authenticated.map_or_else(
        || session_disclosure_authority(arguments),
        |context| Ok(context.authority),
    )
}

fn disclosure_purpose(
    arguments: &Value,
    authenticated: Option<DisclosureContext>,
) -> Result<MemoryPurpose, String> {
    authenticated.map_or_else(
        || parse_memory_purpose(arguments, "disclosure_purpose"),
        |context| Ok(context.purpose),
    )
}

fn parse_capture_adapter(arguments: &Value) -> Result<CaptureAdapter, String> {
    match arguments.get("adapter").and_then(Value::as_str) {
        Some("opencode_codex") => Ok(CaptureAdapter::OpenCodeCodex),
        Some("claude_code") => Ok(CaptureAdapter::ClaudeCode),
        Some("cursor") => Ok(CaptureAdapter::Cursor),
        Some("mcp") => Ok(CaptureAdapter::Mcp),
        Some("webhook") => Ok(CaptureAdapter::Webhook),
        _ => Err("adapter must be opencode_codex|claude_code|cursor|mcp|webhook".to_owned()),
    }
}

fn remember_context(
    arguments: &Value,
    content: &str,
    now_ms: i64,
) -> Result<RememberContext, String> {
    let identity = MemoryIdentity {
        tenant_id: optional_identity(arguments, "tenant_id", TenantId::new)?
            .unwrap_or(TenantId::new("local").expect("static identity")),
        user_id: optional_identity(arguments, "user_id", UserId::new)?
            .unwrap_or(UserId::new("local").expect("static identity")),
        agent_id: optional_identity(arguments, "agent_id", AgentId::new)?,
        project_id: optional_identity(arguments, "project_id", ProjectId::new)?,
        conversation_id: optional_identity(arguments, "conversation_id", ConversationId::new)?,
        session_id: optional_identity(arguments, "session_id", SessionId::new)?,
    };
    let source_kind = match arguments.get("source_kind").and_then(Value::as_str) {
        None => SourceKind::User,
        Some("user") => SourceKind::User,
        Some("assistant") => SourceKind::Assistant,
        Some("tool") => SourceKind::Tool,
        Some("document") => SourceKind::Document,
        Some("system") => SourceKind::System,
        Some("benchmark") => SourceKind::Benchmark,
        Some("legacy") => SourceKind::Legacy,
        Some(_) => return Err("invalid source_kind".to_owned()),
    };
    Ok(RememberContext {
        identity,
        provenance: Provenance::observed(
            source_kind,
            content,
            optional_string(arguments, "source_id")?,
            optional_string(arguments, "source_uri")?,
            optional_string(arguments, "actor")?,
        ),
        event_at_ms: optional_i64(arguments, "event_at_ms")?,
        ingested_at_ms: now_ms,
    })
}

fn recall_scope(arguments: &Value) -> Result<RecallScope, String> {
    Ok(RecallScope {
        tenant_id: optional_identity(arguments, "tenant_id", TenantId::new)?
            .unwrap_or(TenantId::new("local").expect("static identity")),
        user_id: optional_identity(arguments, "user_id", UserId::new)?
            .unwrap_or(UserId::new("local").expect("static identity")),
        project_id: optional_identity(arguments, "project_id", ProjectId::new)?,
        conversation_id: optional_identity(arguments, "conversation_id", ConversationId::new)?,
        session_id: optional_identity(arguments, "session_id", SessionId::new)?,
    })
}

fn scoped_recall_scope(arguments: &Value) -> Result<RecallScope, String> {
    arguments
        .get("_authenticated_scope")
        .map_or_else(|| recall_scope(arguments), recall_scope)
}

fn snapshot_recall_options() -> celiums_memory_engine::RecallOptions {
    let mut options = celiums_memory_engine::RecallOptions::default();
    options.branches.graph = false;
    options.branches.temporal = false;
    options
}

fn optional_identity<T>(
    arguments: &Value,
    field: &str,
    constructor: impl FnOnce(String) -> Result<T, celiums_memory_engine::InvalidIdentity>,
) -> Result<Option<T>, String> {
    optional_string(arguments, field)?
        .map(|value| constructor(value).map_err(|error| error.to_string()))
        .transpose()
}

fn optional_string(arguments: &Value, field: &str) -> Result<Option<String>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(format!("`{field}` must be a non-empty string")),
    }
}

fn optional_i64(arguments: &Value, field: &str) -> Result<Option<i64>, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("`{field}` must be an integer")),
    }
}

fn identity_json(identity: &MemoryIdentity) -> Value {
    json!({
        "tenant_id": identity.tenant_id.as_str(),
        "user_id": identity.user_id.as_str(),
        "agent_id": identity.agent_id.as_ref().map(AgentId::as_str),
        "project_id": identity.project_id.as_ref().map(ProjectId::as_str),
        "conversation_id": identity.conversation_id.as_ref().map(ConversationId::as_str),
        "session_id": identity.session_id.as_ref().map(SessionId::as_str),
    })
}

fn provenance_json(provenance: &Provenance) -> Value {
    json!({
        "source_kind": provenance.source_kind.as_str(),
        "source_id": provenance.source_id,
        "source_uri": provenance.source_uri,
        "actor": provenance.actor,
        "content_hash": provenance.content_hash,
    })
}

fn embedding_space_json(space: &EmbeddingSpaceIdentity) -> Value {
    json!({
        "provider": space.provider,
        "model": space.model,
        "revision": space.revision,
        "dimension": space.dimension,
        "normalization": space.normalization.as_str(),
    })
}

fn string_array(arguments: &Value, field: &str) -> Vec<String> {
    arguments
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn tool_success(value: &Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned()) }],
        "structuredContent": value,
        "isError": false
    })
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
        "structuredContent":{"error":{"code":tool_error_code(message)}}
    })
}

fn tool_error_code(message: &str) -> &'static str {
    if message.contains("embedding")
        || message.contains("quantization")
        || message.contains("vector must contain")
        || message.contains("non-finite")
        || message.contains("zero vector")
    {
        "invalid_request"
    } else if message.contains("revision conflict") {
        "conflict"
    } else if message.contains("not found") {
        "resource_not_found"
    } else if message.contains("idempotency key was already used")
        || message.contains("already ingested with a different payload")
    {
        "conflict"
    } else {
        "operation_failed"
    }
}

fn rpc_result(id: &Value, result: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn request_id(object: &serde_json::Map<String, Value>) -> Value {
    object.get("id").cloned().unwrap_or(Value::Null)
}

fn read_bounded_line<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line.len().saturating_add(consumed) > MAX_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "MCP message exceeds 4 MiB",
            ));
        }
        line.extend_from_slice(&available[..consumed]);
        let complete = available.get(consumed.wrapping_sub(1)) == Some(&b'\n');
        reader.consume(consumed);
        if complete {
            return Ok(Some(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_are_valid_objects() {
        let tools = tool_definitions();
        assert_eq!(tools.len(), 19);
        assert!(tools.iter().all(|tool| tool["inputSchema"].is_object()));
        assert!(tools.iter().all(|tool| tool["name"].is_string()));
    }

    #[test]
    fn bounded_lines_reject_oversized_messages() {
        use std::io::{BufReader, Cursor};
        let oversized = vec![b'x'; MAX_MESSAGE_BYTES + 1];
        let mut reader = BufReader::new(Cursor::new(oversized));
        assert!(read_bounded_line(&mut reader).is_err());
    }
}
