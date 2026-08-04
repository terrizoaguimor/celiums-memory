// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! MCP stdio server over the embedded memory engine.
//!
//! Newline-delimited JSON-RPC 2.0, MCP protocol `2025-11-25`, six
//! tools: `remember`, `recall`, `journal_write`, `journal_recall`,
//! `journal_verify_chain`, `memory_stats`. The transport pattern
//! follows Hyphae's bounded stdio adapter (`hyphae-cli/src/mcp.rs`);
//! the engine is embedded directly — no HTTP hop, no services.
//!
//! Embeddings: callers may pass a pre-computed `embedding` array with
//! `remember`/`recall`; without one the engine's deterministic offline
//! embedder is used, so the binary works with zero providers.

use std::io::{self, BufRead, Write};

use celiums_cognition::{JournalEntryType, Scope};
use celiums_memory_engine::{
    BranchAbstention, JournalRecallRequest, JournalWriteRequest, MemoryEngine, RecallRequest,
    RememberRequest, ScoredMemory, deterministic_embed,
};
use serde_json::{Value, json};

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
    initialize_seen: bool,
    initialized: bool,
}

impl Session {
    /// Creates a session that owns `engine`.
    pub fn new(engine: MemoryEngine, dimension: u16) -> Self {
        Self {
            engine,
            dimension,
            initialize_seen: false,
            initialized: false,
        }
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
                output.flush()?;
            }
        }
    }

    /// Handles one JSON-RPC message; `None` means no response
    /// (notification).
    pub fn handle(&mut self, message: &Value) -> Option<Value> {
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
        match method {
            "initialize" => Some(self.initialize(&id, &params)),
            "ping" => Some(rpc_result(&id, &json!({}))),
            _ if !self.initialized => Some(rpc_error(&id, -32002, "Server not initialized")),
            "tools/list" => Some(rpc_result(&id, &json!({ "tools": tool_definitions() }))),
            "tools/call" => Some(self.call_tool(&id, &params)),
            _ => Some(rpc_error(&id, -32601, "Method not found")),
        }
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
                "capabilities": { "tools": { "listChanged": false } },
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

    fn call_tool(&mut self, id: &Value, params: &Value) -> Value {
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
        let result = match name {
            "remember" => self.tool_remember(&arguments),
            "recall" => self.tool_recall(&arguments),
            "journal_write" => self.tool_journal_write(&arguments),
            "journal_recall" => self.tool_journal_recall(&arguments),
            "journal_verify_chain" => self.tool_journal_verify(&arguments),
            "memory_stats" => self.tool_stats(),
            _ => return rpc_error(id, -32602, "Unknown tool"),
        };
        match result {
            Ok(value) => rpc_result(id, &tool_success(&value)),
            Err(message) => rpc_result(id, &tool_error(&message)),
        }
    }

    fn tool_remember(&mut self, arguments: &Value) -> Result<Value, String> {
        let content = required_string(arguments, "content")?;
        let embedding = self.embedding_from(arguments, &content)?;
        let memory = self
            .engine
            .remember(RememberRequest {
                content,
                embedding,
                tags: string_array(arguments, "tags"),
                scope: arguments
                    .get("scope")
                    .and_then(Value::as_str)
                    .and_then(Scope::parse)
                    .unwrap_or_default(),
                importance: arguments.get("importance").and_then(Value::as_f64),
                now_ms: now_ms(),
            })
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "id": memory.id,
            "importance": memory.importance,
            "memory_type": memory.memory_type.as_str(),
            "valence": memory.pad.pleasure,
            "arousal": memory.pad.arousal,
        }))
    }

    fn tool_recall(&mut self, arguments: &Value) -> Result<Value, String> {
        let query = required_string(arguments, "query")?;
        let embedding = self.embedding_from(arguments, &query)?;
        let limit = arguments
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_RECALL_LIMIT, |value| value.max(1) as usize);
        let response = self
            .engine
            .recall(RecallRequest {
                query_text: query,
                embedding,
                limit,
                current_state: None,
                now_ms: now_ms(),
            })
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "results": response.results.iter().map(scored_json).collect::<Vec<_>>(),
            "semantic_abstention": response.semantic_abstention.map(abstention_str),
            "lexical_abstention": response.lexical_abstention.map(abstention_str),
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

    fn tool_stats(&mut self) -> Result<Value, String> {
        let count = self.engine.count().map_err(|error| error.to_string())?;
        let state = self.engine.affect_state(now_ms());
        Ok(json!({
            "memories": count,
            "affect": {
                "pleasure": state.pleasure,
                "arousal": state.arousal,
                "dominance": state.dominance,
                "label": celiums_cognition::emotion_label(state),
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
}

fn scored_json(scored: &ScoredMemory) -> Value {
    json!({
        "id": scored.memory.id,
        "content": scored.memory.content,
        "score": scored.final_score,
        "importance": scored.memory.importance,
        "memory_type": scored.memory.memory_type.as_str(),
        "tags": scored.memory.tags,
        "channels": {
            "semantic": scored.channels.semantic,
            "text_match": scored.channels.text_match,
            "importance": scored.channels.importance,
            "retrievability": scored.channels.retrievability,
            "emotional": scored.channels.emotional,
            "resonance": scored.channels.resonance,
        },
    })
}

fn abstention_str(reason: BranchAbstention) -> &'static str {
    match reason {
        BranchAbstention::NoCandidates => "no_candidates",
        BranchAbstention::BelowThreshold => "below_threshold",
        BranchAbstention::Ambiguous => "ambiguous",
    }
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
                "importance": { "type": "number", "minimum": 0, "maximum": 1 }
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
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
                },
                "required": ["query"]
            }),
            true,
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
    ]
}

fn tool(name: &str, description: &str, input_schema: &Value, read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": false,
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
        "isError": true
    })
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
        assert_eq!(tools.len(), 6);
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
