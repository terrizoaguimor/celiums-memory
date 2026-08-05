// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable source-event identities and ingestion ledger records.

use std::collections::BTreeMap;
use std::fmt;

use hyphae_query::{Record, Value};
use thiserror::Error;
use uuid::Uuid;

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};

use crate::{
    ConversationId, MemoryIdentity, ProjectId, RecallScope, SessionId, SourceKind, TenantId, UserId,
};

const MAX_ID_BYTES: usize = 255;
const EVENT_ID_DOMAIN: &[u8] = b"celiums-memory/ingestion-event-id/v1";
const INGESTION_KIND: &str = "ingestion_event";
const INGESTION_KEY_PREFIX: &str = "__celiums/ingestion/event/";
const BATCH_KIND: &str = "ingestion_batch";
const BATCH_KEY_PREFIX: &str = "__celiums/ingestion/batch/";
const NANOS: f64 = 1_000_000_000.0;

macro_rules! ingestion_identity {
    ($name:ident, $label:literal) => {
        #[doc = concat!("Validated ", $label, ".")]
        #[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Validates and creates a ", $label, ".")]
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidIngestionIdentity> {
                let value = value.into();
                if value.is_empty()
                    || value.trim() != value
                    || value.len() > MAX_ID_BYTES
                    || value.chars().any(char::is_control)
                {
                    return Err(InvalidIngestionIdentity { kind: $label });
                }
                Ok(Self(value))
            }

            /// Returns the canonical string value.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

ingestion_identity!(SourceNamespace, "source namespace");
ingestion_identity!(SourceEventId, "source event id");
ingestion_identity!(TurnId, "turn id");
ingestion_identity!(BatchId, "batch id");

/// Invalid source, event, or turn identity.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error(
    "{kind} must be 1..=255 bytes, have no surrounding whitespace, and contain no control characters"
)]
pub struct InvalidIngestionIdentity {
    kind: &'static str,
}

/// Stable engine event ID derived from tenant and upstream identity.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct EventId(String);

impl EventId {
    /// Derives a stable UUID from the physical tenant and namespaced source ID.
    pub fn derive(
        tenant_id: &TenantId,
        source_namespace: &SourceNamespace,
        source_event_id: &SourceEventId,
    ) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(EVENT_ID_DOMAIN);
        write_hash_field(&mut hasher, b"tenant_id", tenant_id.as_str().as_bytes());
        write_hash_field(
            &mut hasher,
            b"source_namespace",
            source_namespace.as_str().as_bytes(),
        );
        write_hash_field(
            &mut hasher,
            b"source_event_id",
            source_event_id.as_str().as_bytes(),
        );
        let digest = hasher.finalize();
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest.as_bytes()[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Self(Uuid::from_bytes(bytes).to_string())
    }

    /// Returns the canonical UUID string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn parse(value: String) -> Result<Self, IngestionDecodeError> {
        Uuid::parse_str(&value).map_err(|_| IngestionDecodeError::Field { field: "event_id" })?;
        Ok(Self(value))
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Durable state of one attempted source event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IngestionStatus {
    /// Raw event is durable and awaiting materialization or enrichment.
    Received,
    /// Event produced one durable memory.
    Materialized,
    /// Policy rejected materialization; the attempt remains accounted for.
    Rejected,
    /// A non-policy failure prevented materialization.
    Failed,
}

/// Complete status accounting for visible ingestion events.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct IngestionCoverage {
    /// Unique durable events attempted.
    pub attempted: u64,
    /// Raw events awaiting enrichment.
    pub received: u64,
    /// Events materialized as memories.
    pub materialized: u64,
    /// Events rejected by policy.
    pub rejected: u64,
    /// Events awaiting retry after failure.
    pub failed: u64,
}

impl IngestionCoverage {
    /// Sum of mutually exclusive durable statuses.
    pub fn accounted(self) -> u64 {
        self.received + self.materialized + self.rejected + self.failed
    }
}

impl IngestionStatus {
    /// Stable serialized status name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Materialized => "materialized",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "received" => Some(Self::Received),
            "materialized" => Some(Self::Materialized),
            "rejected" => Some(Self::Rejected),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    /// Whether this event requires no further materialization work.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Materialized | Self::Rejected)
    }
}

/// Aggregate state of one durable ingestion batch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BatchStatus {
    /// At least one item is received or failed and can be resumed.
    Pending,
    /// Every item reached a terminal event state.
    Completed,
}

impl BatchStatus {
    fn from_items(items: &[BatchItemOutcome]) -> Self {
        if items.iter().all(|item| item.status.is_terminal()) {
            Self::Completed
        } else {
            Self::Pending
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "completed" => Some(Self::Completed),
            _ => None,
        }
    }
}

/// Durable outcome of one indexed batch item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchItemOutcome {
    /// Stable input position.
    pub index: usize,
    /// Stable engine event ID.
    pub event_id: EventId,
    /// Current event state.
    pub status: IngestionStatus,
    /// Resulting memory, when materialized.
    pub memory_id: Option<String>,
    /// Stable failure code, when present.
    pub error_code: Option<String>,
    /// Authorization scope of this item.
    pub scope: RecallScope,
}

impl From<&IngestionEntry> for BatchItemOutcome {
    fn from(entry: &IngestionEntry) -> Self {
        Self {
            index: 0,
            event_id: entry.event_id.clone(),
            status: entry.status,
            memory_id: entry.memory_id.clone(),
            error_code: entry.error_code.clone(),
            scope: entry.scope(),
        }
    }
}

/// Durable resumable ingestion job and its latest per-item outcomes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngestionBatch {
    /// Caller-assigned stable job ID.
    pub batch_id: BatchId,
    /// Hash of immutable ordered event membership.
    pub request_hash: String,
    /// Owning scope used for job lookup.
    pub scope: RecallScope,
    /// Current aggregate state.
    pub status: BatchStatus,
    /// First submission time.
    pub created_at_ms: i64,
    /// Most recent submission time.
    pub updated_at_ms: i64,
    /// Number of job submissions.
    pub attempt_count: u64,
    /// Current outcome for every input index.
    pub items: Vec<BatchItemOutcome>,
}

impl IngestionBatch {
    pub(crate) fn new(
        batch_id: BatchId,
        request_hash: String,
        scope: RecallScope,
        now_ms: i64,
        items: Vec<BatchItemOutcome>,
    ) -> Self {
        Self {
            batch_id,
            request_hash,
            scope,
            status: BatchStatus::from_items(&items),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            attempt_count: 1,
            items,
        }
    }

    pub(crate) fn resume(&mut self, now_ms: i64, items: Vec<BatchItemOutcome>) {
        self.updated_at_ms = now_ms;
        self.attempt_count = self.attempt_count.saturating_add(1);
        self.status = BatchStatus::from_items(&items);
        self.items = items;
    }

    pub(crate) fn durable_key(tenant_id: &TenantId, batch_id: &BatchId) -> Vec<u8> {
        let mut hasher = blake3::Hasher::new();
        write_hash_field(&mut hasher, b"tenant_id", tenant_id.as_str().as_bytes());
        write_hash_field(&mut hasher, b"batch_id", batch_id.as_str().as_bytes());
        format!("{BATCH_KEY_PREFIX}{}", hasher.finalize().to_hex()).into_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        Record::new(
            Self::durable_key(&self.scope.tenant_id, &self.batch_id),
            Value::Object(BTreeMap::from([
                ("kind".to_owned(), string(BATCH_KIND)),
                ("batch_id".to_owned(), string(self.batch_id.as_str())),
                ("request_hash".to_owned(), string(&self.request_hash)),
                (
                    "tenant_id".to_owned(),
                    string(self.scope.tenant_id.as_str()),
                ),
                ("user_id".to_owned(), string(self.scope.user_id.as_str())),
                ("status".to_owned(), string(self.status.as_str())),
                (
                    "created_at_ms".to_owned(),
                    Value::Integer(self.created_at_ms),
                ),
                (
                    "updated_at_ms".to_owned(),
                    Value::Integer(self.updated_at_ms),
                ),
                (
                    "attempt_count".to_owned(),
                    Value::Integer(i64::try_from(self.attempt_count).unwrap_or(i64::MAX)),
                ),
                ("scope".to_owned(), scope_value(&self.scope)),
                (
                    "items".to_owned(),
                    Value::Array(self.items.iter().map(batch_item_value).collect()),
                ),
            ])),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, IngestionDecodeError> {
        if !record.key.starts_with(BATCH_KEY_PREFIX.as_bytes()) {
            return Err(IngestionDecodeError::Key);
        }
        let Value::Object(fields) = &record.value else {
            return Err(IngestionDecodeError::Field { field: "(root)" });
        };
        if text(fields, "kind")? != BATCH_KIND {
            return Err(IngestionDecodeError::Field { field: "kind" });
        }
        let items = match fields.get("items") {
            Some(Value::Array(values)) => values
                .iter()
                .map(batch_item_from_value)
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err(IngestionDecodeError::Field { field: "items" }),
        };
        Ok(Self {
            batch_id: BatchId::new(text(fields, "batch_id")?)
                .map_err(|_| IngestionDecodeError::Field { field: "batch_id" })?,
            request_hash: text(fields, "request_hash")?,
            scope: scope_from_value(
                fields
                    .get("scope")
                    .ok_or(IngestionDecodeError::Field { field: "scope" })?,
            )?,
            status: BatchStatus::parse(&text(fields, "status")?)
                .ok_or(IngestionDecodeError::Field { field: "status" })?,
            created_at_ms: integer(fields, "created_at_ms")?,
            updated_at_ms: integer(fields, "updated_at_ms")?,
            attempt_count: unsigned(fields, "attempt_count")?,
            items,
        })
    }
}

/// Durable per-event ingestion ledger entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngestionEntry {
    /// Stable engine event identity.
    pub event_id: EventId,
    /// Integration or adapter namespace.
    pub source_namespace: SourceNamespace,
    /// Stable event identity assigned by that source.
    pub source_event_id: SourceEventId,
    /// Optional grouping identity shared by events in one turn.
    pub turn_id: Option<TurnId>,
    /// Physical and logical ownership of the event.
    pub identity: MemoryIdentity,
    /// Source role or origin class.
    pub source_kind: SourceKind,
    /// Optional address of the raw source.
    pub source_uri: Option<String>,
    /// Optional source actor label.
    pub actor: Option<String>,
    /// Exact raw content received at the ingestion boundary.
    pub content: String,
    /// Tags to apply when materialized.
    pub tags: Vec<String>,
    /// Visibility of the resulting memory.
    pub scope: Scope,
    /// Optional importance override represented as deterministic nanos.
    pub importance_nanos: Option<i64>,
    /// Governance role of the raw content.
    pub content_role: ContentRole,
    /// Declared retention purpose.
    pub purpose: MemoryPurpose,
    /// BLAKE3 of the exact raw content bytes.
    pub content_hash: String,
    /// Hash of all immutable event inputs used for conflict detection.
    pub request_hash: String,
    /// Event time supplied by the source.
    pub event_at_ms: Option<i64>,
    /// First time the engine received the event.
    pub first_ingested_at_ms: i64,
    /// Most recent attempt time.
    pub last_attempted_at_ms: i64,
    /// Number of attempts with this source identity.
    pub attempt_count: u64,
    /// Number of attempts that reused the identity with another payload.
    pub conflict_count: u64,
    /// Current durable outcome.
    pub status: IngestionStatus,
    /// Resulting memory ID, if materialized.
    pub memory_id: Option<String>,
    /// Stable machine-readable error classification.
    pub error_code: Option<String>,
    /// Last provider used for optional enrichment.
    pub enrichment_provider: Option<String>,
    /// Number of provider success/failure attempts.
    pub enrichment_attempt_count: u64,
}

impl IngestionEntry {
    /// Builds a recall scope for the event owner.
    pub fn scope(&self) -> RecallScope {
        RecallScope {
            tenant_id: self.identity.tenant_id.clone(),
            user_id: self.identity.user_id.clone(),
            project_id: self.identity.project_id.clone(),
            conversation_id: self.identity.conversation_id.clone(),
            session_id: self.identity.session_id.clone(),
        }
    }

    pub(crate) fn durable_key(event_id: &EventId) -> Vec<u8> {
        format!("{INGESTION_KEY_PREFIX}{}", event_id.as_str()).into_bytes()
    }

    pub(crate) fn prefix() -> &'static [u8] {
        INGESTION_KEY_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut fields = BTreeMap::from([
            ("kind".to_owned(), string(INGESTION_KIND)),
            ("event_id".to_owned(), string(self.event_id.as_str())),
            (
                "source_namespace".to_owned(),
                string(self.source_namespace.as_str()),
            ),
            (
                "source_event_id".to_owned(),
                string(self.source_event_id.as_str()),
            ),
            (
                "tenant_id".to_owned(),
                string(self.identity.tenant_id.as_str()),
            ),
            ("user_id".to_owned(), string(self.identity.user_id.as_str())),
            ("source_kind".to_owned(), string(self.source_kind.as_str())),
            ("content".to_owned(), string(&self.content)),
            (
                "tags".to_owned(),
                Value::Array(self.tags.iter().map(|tag| string(tag)).collect()),
            ),
            ("scope".to_owned(), string(self.scope.as_str())),
            (
                "importance_nanos".to_owned(),
                self.importance_nanos.map_or(Value::Null, Value::Integer),
            ),
            (
                "content_role".to_owned(),
                string(content_role_name(self.content_role)),
            ),
            ("purpose".to_owned(), string(purpose_name(self.purpose))),
            ("content_hash".to_owned(), string(&self.content_hash)),
            ("request_hash".to_owned(), string(&self.request_hash)),
            (
                "first_ingested_at_ms".to_owned(),
                Value::Integer(self.first_ingested_at_ms),
            ),
            (
                "last_attempted_at_ms".to_owned(),
                Value::Integer(self.last_attempted_at_ms),
            ),
            (
                "attempt_count".to_owned(),
                Value::Integer(i64::try_from(self.attempt_count).unwrap_or(i64::MAX)),
            ),
            (
                "conflict_count".to_owned(),
                Value::Integer(i64::try_from(self.conflict_count).unwrap_or(i64::MAX)),
            ),
            ("status".to_owned(), string(self.status.as_str())),
        ]);
        insert_optional(
            &mut fields,
            "turn_id",
            self.turn_id.as_ref().map(TurnId::as_str),
        );
        insert_optional(
            &mut fields,
            "agent_id",
            self.identity.agent_id.as_ref().map(crate::AgentId::as_str),
        );
        insert_optional(
            &mut fields,
            "project_id",
            self.identity.project_id.as_ref().map(ProjectId::as_str),
        );
        insert_optional(
            &mut fields,
            "conversation_id",
            self.identity
                .conversation_id
                .as_ref()
                .map(ConversationId::as_str),
        );
        insert_optional(
            &mut fields,
            "session_id",
            self.identity.session_id.as_ref().map(SessionId::as_str),
        );
        insert_optional(&mut fields, "source_uri", self.source_uri.as_deref());
        insert_optional(&mut fields, "source_actor", self.actor.as_deref());
        fields.insert(
            "event_at_ms".to_owned(),
            self.event_at_ms.map_or(Value::Null, Value::Integer),
        );
        insert_optional(&mut fields, "memory_id", self.memory_id.as_deref());
        insert_optional(&mut fields, "error_code", self.error_code.as_deref());
        insert_optional(
            &mut fields,
            "enrichment_provider",
            self.enrichment_provider.as_deref(),
        );
        fields.insert(
            "enrichment_attempt_count".to_owned(),
            Value::Integer(i64::try_from(self.enrichment_attempt_count).unwrap_or(i64::MAX)),
        );
        Record::new(Self::durable_key(&self.event_id), Value::Object(fields))
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, IngestionDecodeError> {
        if !record.key.starts_with(Self::prefix()) {
            return Err(IngestionDecodeError::Key);
        }
        let Value::Object(fields) = &record.value else {
            return Err(IngestionDecodeError::Field { field: "(root)" });
        };
        if text(fields, "kind")? != INGESTION_KIND {
            return Err(IngestionDecodeError::Field { field: "kind" });
        }
        let source_kind = SourceKind::parse(&text(fields, "source_kind")?).ok_or(
            IngestionDecodeError::Field {
                field: "source_kind",
            },
        )?;
        Ok(Self {
            event_id: EventId::parse(text(fields, "event_id")?)?,
            source_namespace: SourceNamespace::new(text(fields, "source_namespace")?).map_err(
                |_| IngestionDecodeError::Field {
                    field: "source_namespace",
                },
            )?,
            source_event_id: SourceEventId::new(text(fields, "source_event_id")?).map_err(
                |_| IngestionDecodeError::Field {
                    field: "source_event_id",
                },
            )?,
            turn_id: optional_text(fields, "turn_id")?
                .map(TurnId::new)
                .transpose()
                .map_err(|_| IngestionDecodeError::Field { field: "turn_id" })?,
            identity: MemoryIdentity {
                tenant_id: TenantId::new(text(fields, "tenant_id")?)
                    .map_err(|_| IngestionDecodeError::Field { field: "tenant_id" })?,
                user_id: UserId::new(text(fields, "user_id")?)
                    .map_err(|_| IngestionDecodeError::Field { field: "user_id" })?,
                agent_id: optional_identity(fields, "agent_id", crate::AgentId::new)?,
                project_id: optional_identity(fields, "project_id", ProjectId::new)?,
                conversation_id: optional_identity(fields, "conversation_id", ConversationId::new)?,
                session_id: optional_identity(fields, "session_id", SessionId::new)?,
            },
            source_kind,
            source_uri: optional_text(fields, "source_uri")?,
            actor: optional_text(fields, "source_actor")?,
            content: text(fields, "content")?,
            tags: string_array(fields, "tags")?,
            scope: Scope::parse(&text(fields, "scope")?)
                .ok_or(IngestionDecodeError::Field { field: "scope" })?,
            importance_nanos: optional_integer(fields, "importance_nanos")?,
            content_role: parse_content_role(&text(fields, "content_role")?).ok_or(
                IngestionDecodeError::Field {
                    field: "content_role",
                },
            )?,
            purpose: parse_purpose(&text(fields, "purpose")?)
                .ok_or(IngestionDecodeError::Field { field: "purpose" })?,
            content_hash: text(fields, "content_hash")?,
            request_hash: text(fields, "request_hash")?,
            event_at_ms: optional_integer(fields, "event_at_ms")?,
            first_ingested_at_ms: integer(fields, "first_ingested_at_ms")?,
            last_attempted_at_ms: integer(fields, "last_attempted_at_ms")?,
            attempt_count: unsigned(fields, "attempt_count")?,
            conflict_count: unsigned(fields, "conflict_count")?,
            status: IngestionStatus::parse(&text(fields, "status")?)
                .ok_or(IngestionDecodeError::Field { field: "status" })?,
            memory_id: optional_text(fields, "memory_id")?,
            error_code: optional_text(fields, "error_code")?,
            enrichment_provider: optional_text(fields, "enrichment_provider")?,
            enrichment_attempt_count: unsigned(fields, "enrichment_attempt_count")?,
        })
    }
}

impl IngestionEntry {
    /// Returns the optional importance override in the public scalar domain.
    pub fn importance(&self) -> Option<f64> {
        #[allow(clippy::cast_precision_loss)]
        self.importance_nanos.map(|value| value as f64 / NANOS)
    }
}

/// Failure decoding a durable ingestion entry.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum IngestionDecodeError {
    /// Record key is outside the ingestion namespace.
    #[error("record key is not an ingestion event key")]
    Key,
    /// A required field is absent, mistyped, or invalid.
    #[error("ingestion document field `{field}` is missing, mistyped, or invalid")]
    Field {
        /// Offending field.
        field: &'static str,
    },
}

fn write_hash_field(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn insert_optional(fields: &mut BTreeMap<String, Value>, field: &str, value: Option<&str>) {
    fields.insert(field.to_owned(), value.map_or(Value::Null, string));
}

fn text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<String, IngestionDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(IngestionDecodeError::Field { field }),
    }
}

fn optional_text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<String>, IngestionDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(IngestionDecodeError::Field { field }),
    }
}

fn integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<i64, IngestionDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => Err(IngestionDecodeError::Field { field }),
    }
}

fn optional_integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<i64>, IngestionDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => Err(IngestionDecodeError::Field { field }),
    }
}

fn unsigned(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<u64, IngestionDecodeError> {
    integer(fields, field)?
        .try_into()
        .map_err(|_| IngestionDecodeError::Field { field })
}

fn optional_identity<T>(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
    constructor: impl FnOnce(String) -> Result<T, crate::InvalidIdentity>,
) -> Result<Option<T>, IngestionDecodeError> {
    optional_text(fields, field)?
        .map(|value| constructor(value).map_err(|_| IngestionDecodeError::Field { field }))
        .transpose()
}

fn string_array(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<String>, IngestionDecodeError> {
    match fields.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                _ => Err(IngestionDecodeError::Field { field }),
            })
            .collect(),
        _ => Err(IngestionDecodeError::Field { field }),
    }
}

fn content_role_name(role: ContentRole) -> &'static str {
    match role {
        ContentRole::Observation => "observation",
        ContentRole::Description => "description",
        ContentRole::OperationalRequest => "operational_request",
    }
}

fn parse_content_role(value: &str) -> Option<ContentRole> {
    match value {
        "observation" => Some(ContentRole::Observation),
        "description" => Some(ContentRole::Description),
        "operational_request" => Some(ContentRole::OperationalRequest),
        _ => None,
    }
}

fn purpose_name(purpose: MemoryPurpose) -> &'static str {
    match purpose {
        MemoryPurpose::ConversationalContext => "conversational_context",
        MemoryPurpose::Personalization => "personalization",
        MemoryPurpose::TaskExecution => "task_execution",
        MemoryPurpose::SafetyAudit => "safety_audit",
    }
}

fn parse_purpose(value: &str) -> Option<MemoryPurpose> {
    match value {
        "conversational_context" => Some(MemoryPurpose::ConversationalContext),
        "personalization" => Some(MemoryPurpose::Personalization),
        "task_execution" => Some(MemoryPurpose::TaskExecution),
        "safety_audit" => Some(MemoryPurpose::SafetyAudit),
        _ => None,
    }
}

fn scope_value(scope: &RecallScope) -> Value {
    let mut fields = BTreeMap::from([
        ("tenant_id".to_owned(), string(scope.tenant_id.as_str())),
        ("user_id".to_owned(), string(scope.user_id.as_str())),
    ]);
    insert_optional(
        &mut fields,
        "project_id",
        scope.project_id.as_ref().map(ProjectId::as_str),
    );
    insert_optional(
        &mut fields,
        "conversation_id",
        scope.conversation_id.as_ref().map(ConversationId::as_str),
    );
    insert_optional(
        &mut fields,
        "session_id",
        scope.session_id.as_ref().map(SessionId::as_str),
    );
    Value::Object(fields)
}

fn scope_from_value(value: &Value) -> Result<RecallScope, IngestionDecodeError> {
    let Value::Object(fields) = value else {
        return Err(IngestionDecodeError::Field { field: "scope" });
    };
    Ok(RecallScope {
        tenant_id: TenantId::new(text(fields, "tenant_id")?)
            .map_err(|_| IngestionDecodeError::Field { field: "scope" })?,
        user_id: UserId::new(text(fields, "user_id")?)
            .map_err(|_| IngestionDecodeError::Field { field: "scope" })?,
        project_id: optional_identity(fields, "project_id", ProjectId::new)?,
        conversation_id: optional_identity(fields, "conversation_id", ConversationId::new)?,
        session_id: optional_identity(fields, "session_id", SessionId::new)?,
    })
}

fn batch_item_value(item: &BatchItemOutcome) -> Value {
    Value::Object(BTreeMap::from([
        (
            "index".to_owned(),
            Value::Integer(i64::try_from(item.index).unwrap_or(i64::MAX)),
        ),
        ("event_id".to_owned(), string(item.event_id.as_str())),
        ("status".to_owned(), string(item.status.as_str())),
        (
            "memory_id".to_owned(),
            item.memory_id.as_deref().map_or(Value::Null, string),
        ),
        (
            "error_code".to_owned(),
            item.error_code.as_deref().map_or(Value::Null, string),
        ),
        ("scope".to_owned(), scope_value(&item.scope)),
    ]))
}

fn batch_item_from_value(value: &Value) -> Result<BatchItemOutcome, IngestionDecodeError> {
    let Value::Object(fields) = value else {
        return Err(IngestionDecodeError::Field { field: "items" });
    };
    Ok(BatchItemOutcome {
        index: unsigned(fields, "index")?
            .try_into()
            .map_err(|_| IngestionDecodeError::Field { field: "index" })?,
        event_id: EventId::parse(text(fields, "event_id")?)?,
        status: IngestionStatus::parse(&text(fields, "status")?)
            .ok_or(IngestionDecodeError::Field { field: "status" })?,
        memory_id: optional_text(fields, "memory_id")?,
        error_code: optional_text(fields, "error_code")?,
        scope: scope_from_value(
            fields
                .get("scope")
                .ok_or(IngestionDecodeError::Field { field: "scope" })?,
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_are_stable_and_namespaced() {
        let tenant = TenantId::new("tenant-a").expect("tenant");
        let other_tenant = TenantId::new("tenant-b").expect("tenant");
        let namespace = SourceNamespace::new("opencode").expect("namespace");
        let other_namespace = SourceNamespace::new("cursor").expect("namespace");
        let source_id = SourceEventId::new("prompt-42").expect("source id");

        assert_eq!(
            EventId::derive(&tenant, &namespace, &source_id),
            EventId::derive(&tenant, &namespace, &source_id)
        );
        assert_ne!(
            EventId::derive(&tenant, &namespace, &source_id),
            EventId::derive(&other_tenant, &namespace, &source_id)
        );
        assert_ne!(
            EventId::derive(&tenant, &namespace, &source_id),
            EventId::derive(&tenant, &other_namespace, &source_id)
        );
    }
}
