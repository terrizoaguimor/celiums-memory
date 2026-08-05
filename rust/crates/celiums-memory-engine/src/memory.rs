// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The durable memory record and its canonical Hyphae document codec.
//!
//! Hyphae documents deliberately have no float type (deterministic
//! total ordering), so every cognitive scalar is stored as integer
//! nanos (`value * 1e9`), the same convention Hyphae itself uses for
//! scores.

use std::collections::BTreeMap;

use celiums_cognition::{EntityKind, ExtractedEntity, MemoryState, MemoryType, Pad, Scope};
use hyphae_query::{Record, Value};
use thiserror::Error;

use crate::EmbeddingSpaceIdentity;
use crate::identity::{
    AgentId, ConversationId, MemoryIdentity, ProjectId, Provenance, SessionId, SourceKind,
    TenantId, UserId,
};

/// Nanos scale shared with Hyphae score semantics.
const NANOS: f64 = 1_000_000_000.0;

/// One durable memory with its cognitive metadata.
#[derive(Clone, Debug, PartialEq)]
pub struct Memory {
    /// Stable identifier (UUID string; also the binary record key).
    pub id: String,
    /// Durable document schema version.
    pub schema_version: u32,
    /// Optimistic-concurrency revision, starting at one.
    pub revision: u64,
    /// Security and query identity.
    pub identity: MemoryIdentity,
    /// Trace to the observation that produced the memory.
    pub provenance: Provenance,
    /// Embedding space used by this memory's vector.
    pub embedding_space: Option<EmbeddingSpaceIdentity>,
    /// Raw remembered text.
    pub content: String,
    /// Importance in `[0, 1]`.
    pub importance: f64,
    /// PAD affect snapshot taken at encoding time.
    pub pad: Pad,
    /// Ebbinghaus strength (effective half-life in days).
    pub strength: f64,
    /// Number of successful recalls.
    pub retrieval_count: u32,
    /// Memory classification.
    pub memory_type: MemoryType,
    /// Lifecycle state; archived memories are excluded from recall.
    pub state: MemoryState,
    /// Visibility scope.
    pub scope: Scope,
    /// Free-form tags.
    pub tags: Vec<String>,
    /// Entities the memory binds to (hippocampal binding).
    pub entities: Vec<ExtractedEntity>,
    /// Times consolidation merged another observation into this one.
    pub consolidation_count: u32,
    /// Creation time, Unix milliseconds.
    pub created_at_ms: i64,
    /// Last metadata/content update time, Unix milliseconds.
    pub updated_at_ms: i64,
    /// Event time supplied by the source, when known.
    pub event_at_ms: Option<i64>,
    /// Ingestion time at the engine boundary.
    pub ingested_at_ms: i64,
    /// Last recall time, Unix milliseconds.
    pub last_retrieved_at_ms: i64,
}

/// Failure decoding a stored document back into a [`Memory`].
#[derive(Debug, Error)]
pub enum MemoryDecodeError {
    /// A required field is missing or has the wrong type.
    #[error("memory document field `{field}` is missing or mistyped")]
    Field {
        /// Offending field name.
        field: &'static str,
    },
    /// The record key is not valid UTF-8.
    #[error("memory record key is not valid UTF-8")]
    Key,
}

/// Discriminator value for memory records; the affect-state record
/// carries `kind = "affect_state"` instead.
pub(crate) const MEMORY_KIND: &str = "memory";

impl Memory {
    /// Binary record key for this memory.
    pub fn key(&self) -> Vec<u8> {
        self.id.as_bytes().to_vec()
    }

    /// Encodes this memory as a canonical Hyphae record.
    pub fn to_record(&self) -> Record {
        let mut fields = BTreeMap::new();
        fields.insert("kind".to_owned(), Value::String(MEMORY_KIND.to_owned()));
        fields.insert(
            "schema_version".to_owned(),
            Value::Integer(i64::from(self.schema_version)),
        );
        fields.insert(
            "revision".to_owned(),
            Value::Integer(i64::try_from(self.revision).unwrap_or(i64::MAX)),
        );
        fields.insert(
            "tenant_id".to_owned(),
            Value::String(self.identity.tenant_id.to_string()),
        );
        fields.insert(
            "user_id".to_owned(),
            Value::String(self.identity.user_id.to_string()),
        );
        insert_optional_identity(&mut fields, "agent_id", self.identity.agent_id.as_ref());
        insert_optional_identity(&mut fields, "project_id", self.identity.project_id.as_ref());
        insert_optional_identity(
            &mut fields,
            "conversation_id",
            self.identity.conversation_id.as_ref(),
        );
        insert_optional_identity(&mut fields, "session_id", self.identity.session_id.as_ref());
        fields.insert(
            "source_kind".to_owned(),
            Value::String(self.provenance.source_kind.as_str().to_owned()),
        );
        insert_optional_string(&mut fields, "source_id", self.provenance.source_id.as_ref());
        insert_optional_string(
            &mut fields,
            "source_uri",
            self.provenance.source_uri.as_ref(),
        );
        insert_optional_string(&mut fields, "source_actor", self.provenance.actor.as_ref());
        fields.insert(
            "content_hash".to_owned(),
            Value::String(self.provenance.content_hash.clone()),
        );
        if let Some(space) = &self.embedding_space {
            fields.insert(
                "embedding_provider".to_owned(),
                Value::String(space.provider.clone()),
            );
            fields.insert(
                "embedding_model".to_owned(),
                Value::String(space.model.clone()),
            );
            fields.insert(
                "embedding_revision".to_owned(),
                Value::String(space.revision.clone()),
            );
            fields.insert(
                "embedding_dimension".to_owned(),
                Value::Integer(i64::from(space.dimension)),
            );
            fields.insert(
                "embedding_normalization".to_owned(),
                Value::String(space.normalization.as_str().to_owned()),
            );
        }
        fields.insert("content".to_owned(), Value::String(self.content.clone()));
        fields.insert("importance".to_owned(), nanos_value(self.importance));
        fields.insert("valence".to_owned(), nanos_value(self.pad.pleasure));
        fields.insert("arousal".to_owned(), nanos_value(self.pad.arousal));
        fields.insert("dominance".to_owned(), nanos_value(self.pad.dominance));
        fields.insert("strength".to_owned(), nanos_value(self.strength));
        fields.insert(
            "retrieval_count".to_owned(),
            Value::Integer(i64::from(self.retrieval_count)),
        );
        fields.insert(
            "memory_type".to_owned(),
            Value::String(self.memory_type.as_str().to_owned()),
        );
        fields.insert(
            "state".to_owned(),
            Value::String(self.state.as_str().to_owned()),
        );
        fields.insert(
            "scope".to_owned(),
            Value::String(self.scope.as_str().to_owned()),
        );
        fields.insert(
            "tags".to_owned(),
            Value::Array(self.tags.iter().cloned().map(Value::String).collect()),
        );
        fields.insert(
            "entities".to_owned(),
            Value::Array(
                self.entities
                    .iter()
                    .map(|entity| {
                        Value::Object(BTreeMap::from([
                            ("name".to_owned(), Value::String(entity.name.clone())),
                            (
                                "entity_kind".to_owned(),
                                Value::String(entity.kind.as_str().to_owned()),
                            ),
                            ("salience".to_owned(), nanos_value(entity.salience)),
                        ]))
                    })
                    .collect(),
            ),
        );
        fields.insert(
            "consolidation_count".to_owned(),
            Value::Integer(i64::from(self.consolidation_count)),
        );
        fields.insert(
            "created_at_ms".to_owned(),
            Value::Integer(self.created_at_ms),
        );
        fields.insert(
            "updated_at_ms".to_owned(),
            Value::Integer(self.updated_at_ms),
        );
        fields.insert(
            "event_at_ms".to_owned(),
            self.event_at_ms.map_or(Value::Null, Value::Integer),
        );
        fields.insert(
            "ingested_at_ms".to_owned(),
            Value::Integer(self.ingested_at_ms),
        );
        fields.insert(
            "last_retrieved_at_ms".to_owned(),
            Value::Integer(self.last_retrieved_at_ms),
        );
        Record::new(self.key(), Value::Object(fields))
    }

    /// Decodes a stored record back into a memory.
    ///
    /// # Errors
    ///
    /// Fails loudly on any missing or mistyped field — a partially
    /// readable memory must never silently participate in recall.
    pub fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let id = String::from_utf8(record.key.clone()).map_err(|_| MemoryDecodeError::Key)?;
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field { field: "(root)" });
        };
        let content = string_field(fields, "content")?;
        Ok(Self {
            id,
            schema_version: optional_integer_field(fields, "schema_version")?
                .unwrap_or(0)
                .try_into()
                .map_err(|_| MemoryDecodeError::Field {
                    field: "schema_version",
                })?,
            revision: optional_integer_field(fields, "revision")?
                .unwrap_or(1)
                .try_into()
                .map_err(|_| MemoryDecodeError::Field { field: "revision" })?,
            identity: identity_fields(fields)?,
            provenance: provenance_fields(fields, &content)?,
            embedding_space: embedding_space_fields(fields)?,
            content,
            importance: nanos_field(fields, "importance")?,
            pad: Pad {
                pleasure: nanos_field(fields, "valence")?,
                arousal: nanos_field(fields, "arousal")?,
                dominance: nanos_field(fields, "dominance")?,
            },
            strength: nanos_field(fields, "strength")?,
            retrieval_count: integer_field(fields, "retrieval_count")?
                .try_into()
                .map_err(|_| MemoryDecodeError::Field {
                    field: "retrieval_count",
                })?,
            memory_type: MemoryType::parse(&string_field(fields, "memory_type")?).ok_or(
                MemoryDecodeError::Field {
                    field: "memory_type",
                },
            )?,
            state: MemoryState::parse(&string_field(fields, "state")?)
                .ok_or(MemoryDecodeError::Field { field: "state" })?,
            scope: Scope::parse(&string_field(fields, "scope")?)
                .ok_or(MemoryDecodeError::Field { field: "scope" })?,
            tags: tags_field(fields)?,
            entities: entities_field(fields)?,
            consolidation_count: integer_field(fields, "consolidation_count")?
                .try_into()
                .map_err(|_| MemoryDecodeError::Field {
                    field: "consolidation_count",
                })?,
            created_at_ms: integer_field(fields, "created_at_ms")?,
            updated_at_ms: optional_integer_field(fields, "updated_at_ms")?
                .unwrap_or(integer_field(fields, "created_at_ms")?),
            event_at_ms: optional_integer_field(fields, "event_at_ms")?,
            ingested_at_ms: optional_integer_field(fields, "ingested_at_ms")?
                .unwrap_or(integer_field(fields, "created_at_ms")?),
            last_retrieved_at_ms: integer_field(fields, "last_retrieved_at_ms")?,
        })
    }
}

trait IdentityValue {
    fn as_identity_str(&self) -> &str;
}

macro_rules! impl_identity_value {
    ($($kind:ty),+ $(,)?) => {
        $(impl IdentityValue for $kind {
            fn as_identity_str(&self) -> &str { self.as_str() }
        })+
    };
}

impl_identity_value!(AgentId, ProjectId, ConversationId, SessionId);

fn insert_optional_identity<T: IdentityValue>(
    fields: &mut BTreeMap<String, Value>,
    field: &str,
    value: Option<&T>,
) {
    fields.insert(
        field.to_owned(),
        value.map_or(Value::Null, |id| {
            Value::String(id.as_identity_str().to_owned())
        }),
    );
}

fn insert_optional_string(
    fields: &mut BTreeMap<String, Value>,
    field: &str,
    value: Option<&String>,
) {
    fields.insert(
        field.to_owned(),
        value.map_or(Value::Null, |text| Value::String(text.clone())),
    );
}

fn identity_fields(fields: &BTreeMap<String, Value>) -> Result<MemoryIdentity, MemoryDecodeError> {
    let tenant_id =
        optional_string_field(fields, "tenant_id")?.unwrap_or_else(|| "local".to_owned());
    let user_id = optional_string_field(fields, "user_id")?.unwrap_or_else(|| "local".to_owned());
    Ok(MemoryIdentity {
        tenant_id: TenantId::new(tenant_id)
            .map_err(|_| MemoryDecodeError::Field { field: "tenant_id" })?,
        user_id: UserId::new(user_id).map_err(|_| MemoryDecodeError::Field { field: "user_id" })?,
        agent_id: optional_identity_field(fields, "agent_id", AgentId::new)?,
        project_id: optional_identity_field(fields, "project_id", ProjectId::new)?,
        conversation_id: optional_identity_field(fields, "conversation_id", ConversationId::new)?,
        session_id: optional_identity_field(fields, "session_id", SessionId::new)?,
    })
}

fn optional_identity_field<T>(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
    constructor: impl FnOnce(String) -> Result<T, crate::InvalidIdentity>,
) -> Result<Option<T>, MemoryDecodeError> {
    optional_string_field(fields, field)?
        .map(|value| constructor(value).map_err(|_| MemoryDecodeError::Field { field }))
        .transpose()
}

fn provenance_fields(
    fields: &BTreeMap<String, Value>,
    content: &str,
) -> Result<Provenance, MemoryDecodeError> {
    let Some(source_kind) = optional_string_field(fields, "source_kind")? else {
        return Ok(Provenance::legacy(content));
    };
    Ok(Provenance {
        source_kind: SourceKind::parse(&source_kind).ok_or(MemoryDecodeError::Field {
            field: "source_kind",
        })?,
        source_id: optional_string_field(fields, "source_id")?,
        source_uri: optional_string_field(fields, "source_uri")?,
        actor: optional_string_field(fields, "source_actor")?,
        content_hash: string_field(fields, "content_hash")?,
    })
}

fn embedding_space_fields(
    fields: &BTreeMap<String, Value>,
) -> Result<Option<EmbeddingSpaceIdentity>, MemoryDecodeError> {
    let Some(provider) = optional_string_field(fields, "embedding_provider")? else {
        return Ok(None);
    };
    let model = string_field(fields, "embedding_model")?;
    let revision = string_field(fields, "embedding_revision")?;
    let dimension = integer_field(fields, "embedding_dimension")?
        .try_into()
        .map_err(|_| MemoryDecodeError::Field {
            field: "embedding_dimension",
        })?;
    let normalization = match string_field(fields, "embedding_normalization")?.as_str() {
        "l2" => crate::EmbeddingNormalization::L2,
        _ => {
            return Err(MemoryDecodeError::Field {
                field: "embedding_normalization",
            });
        }
    };
    EmbeddingSpaceIdentity::new(provider, model, revision, dimension, normalization)
        .map(Some)
        .map_err(|_| MemoryDecodeError::Field {
            field: "embedding_space",
        })
}

fn entities_field(
    fields: &BTreeMap<String, Value>,
) -> Result<Vec<ExtractedEntity>, MemoryDecodeError> {
    let Some(Value::Array(values)) = fields.get("entities") else {
        return Err(MemoryDecodeError::Field { field: "entities" });
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(entity) = value else {
                return Err(MemoryDecodeError::Field { field: "entities" });
            };
            Ok(ExtractedEntity {
                name: string_field(entity, "name")?,
                kind: EntityKind::parse(&string_field(entity, "entity_kind")?)
                    .ok_or(MemoryDecodeError::Field { field: "entities" })?,
                salience: nanos_field(entity, "salience")?,
            })
        })
        .collect()
}

pub(crate) fn nanos_value(value: f64) -> Value {
    // Cognitive scalars live in [-1, 1] (or small positives for
    // strength), so the scaled magnitude is far below i64::MAX.
    #[allow(clippy::cast_possible_truncation)]
    Value::Integer((value * NANOS).round() as i64)
}

pub(crate) fn nanos_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<f64, MemoryDecodeError> {
    #[allow(clippy::cast_precision_loss)]
    integer_field(fields, field).map(|nanos| nanos as f64 / NANOS)
}

pub(crate) fn integer_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<i64, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn string_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<String, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn optional_string_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<String>, MemoryDecodeError> {
    match fields.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn optional_integer_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<i64>, MemoryDecodeError> {
    match fields.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn tags_field(fields: &BTreeMap<String, Value>) -> Result<Vec<String>, MemoryDecodeError> {
    match fields.get("tags") {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(tag) => Ok(tag.clone()),
                _ => Err(MemoryDecodeError::Field { field: "tags" }),
            })
            .collect(),
        _ => Err(MemoryDecodeError::Field { field: "tags" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Memory {
        Memory {
            id: "0195f0a2-1111-7000-8000-000000000001".to_owned(),
            schema_version: 1,
            revision: 1,
            identity: MemoryIdentity {
                tenant_id: TenantId::new("tenant-a").expect("tenant"),
                user_id: UserId::new("user-a").expect("user"),
                agent_id: Some(AgentId::new("agent-a").expect("agent")),
                project_id: Some(ProjectId::new("project-a").expect("project")),
                conversation_id: Some(ConversationId::new("conversation-a").expect("conversation")),
                session_id: Some(SessionId::new("session-a").expect("session")),
            },
            provenance: Provenance::observed(
                SourceKind::User,
                "We decided to port the engine to Rust",
                Some("message-1".to_owned()),
                Some("mcp://conversation-a/message-1".to_owned()),
                Some("Mario".to_owned()),
            ),
            embedding_space: Some(
                EmbeddingSpaceIdentity::new(
                    "workers-ai",
                    "bge-m3",
                    "2026-06",
                    1024,
                    crate::EmbeddingNormalization::L2,
                )
                .expect("embedding identity"),
            ),
            content: "We decided to port the engine to Rust".to_owned(),
            importance: 0.85,
            pad: Pad {
                pleasure: 0.6,
                arousal: 0.2,
                dominance: 0.4,
            },
            strength: 1.0,
            retrieval_count: 3,
            memory_type: MemoryType::Episodic,
            state: MemoryState::Active,
            scope: Scope::Project,
            tags: vec!["rust".to_owned(), "decision".to_owned()],
            entities: vec![ExtractedEntity {
                name: "rust".to_owned(),
                kind: EntityKind::Technology,
                salience: 0.5,
            }],
            consolidation_count: 1,
            created_at_ms: 1_770_000_000_000,
            updated_at_ms: 1_770_000_000_000,
            event_at_ms: Some(1_769_999_000_000),
            ingested_at_ms: 1_770_000_000_000,
            last_retrieved_at_ms: 1_770_100_000_000,
        }
    }

    #[test]
    fn memory_round_trips_through_record() {
        let memory = sample();
        let decoded = Memory::from_record(&memory.to_record()).expect("round trip");
        assert_eq!(decoded, memory);
    }

    #[test]
    fn nanos_precision_survives_round_trip() {
        let mut memory = sample();
        memory.importance = 0.123_456_789;
        memory.pad.pleasure = -0.987_654_321;
        let decoded = Memory::from_record(&memory.to_record()).expect("round trip");
        assert!((decoded.importance - memory.importance).abs() < 1e-9);
        assert!((decoded.pad.pleasure - memory.pad.pleasure).abs() < 1e-9);
    }

    #[test]
    fn decode_rejects_missing_fields() {
        let record = Record::new(b"id".to_vec(), Value::Object(BTreeMap::new()));
        let error = Memory::from_record(&record).expect_err("must fail");
        assert!(matches!(
            error,
            MemoryDecodeError::Field { field: "content" }
        ));
    }

    #[test]
    fn decode_rejects_non_object_root() {
        let record = Record::new(b"id".to_vec(), Value::String("nope".to_owned()));
        assert!(Memory::from_record(&record).is_err());
    }

    #[test]
    fn legacy_record_defaults_identity_and_provenance_without_losing_content() {
        let memory = sample();
        let mut record = memory.to_record();
        let Value::Object(fields) = &mut record.value else {
            panic!("object");
        };
        for field in [
            "tenant_id",
            "user_id",
            "agent_id",
            "project_id",
            "conversation_id",
            "session_id",
            "source_kind",
            "source_id",
            "source_uri",
            "source_actor",
            "content_hash",
            "event_at_ms",
            "ingested_at_ms",
            "schema_version",
            "revision",
            "updated_at_ms",
            "embedding_provider",
            "embedding_model",
            "embedding_revision",
            "embedding_dimension",
            "embedding_normalization",
        ] {
            fields.remove(field);
        }

        let decoded = Memory::from_record(&record).expect("legacy decode");
        assert_eq!(decoded.identity, MemoryIdentity::local());
        assert_eq!(decoded.provenance.source_kind, SourceKind::Legacy);
        assert_eq!(decoded.provenance.content_hash.len(), 64);
        assert_eq!(decoded.event_at_ms, None);
        assert_eq!(decoded.ingested_at_ms, decoded.created_at_ms);
        assert_eq!(decoded.schema_version, 0);
        assert_eq!(decoded.revision, 1);
        assert_eq!(decoded.updated_at_ms, decoded.created_at_ms);
        assert_eq!(decoded.embedding_space, None);
    }
}
