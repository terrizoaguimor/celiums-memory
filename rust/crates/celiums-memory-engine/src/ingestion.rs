// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable source-event identities and ingestion ledger records.

use std::collections::BTreeMap;
use std::fmt;

use hyphae_query::{Record, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    ConversationId, MemoryIdentity, ProjectId, RecallScope, SessionId, SourceKind, TenantId, UserId,
};

const MAX_ID_BYTES: usize = 255;
const EVENT_ID_DOMAIN: &[u8] = b"celiums-memory/ingestion-event-id/v1";
const INGESTION_KIND: &str = "ingestion_event";
const INGESTION_KEY_PREFIX: &str = "__celiums/ingestion/event/";

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

    fn parse(value: String) -> Result<Self, IngestionDecodeError> {
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

impl IngestionStatus {
    pub(crate) fn as_str(self) -> &'static str {
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
        })
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
