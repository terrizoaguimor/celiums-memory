// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable idempotency identities and canonical remember-request hashing.

use std::collections::BTreeMap;
use std::fmt;

use hyphae_core::Q15Vector;
use hyphae_query::{Record, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::{Memory, TenantId};

const MAX_KEY_BYTES: usize = 255;
const REMEMBER_KIND: &str = "remember";
const REMEMBER_KEY_PREFIX: &str = "__celiums/idempotency/remember/";
const REQUEST_HASH_DOMAIN: &[u8] = b"celiums-memory/remember-request/v1";
const UUID_DOMAIN: &[u8] = b"celiums-memory/remember-id/v1";
const NANOS: f64 = 1_000_000_000.0;

/// A caller-supplied key identifying one logical operation.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    /// Validates and creates an idempotency key.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidIdempotencyKey`] when the value is empty, exceeds
    /// 255 bytes, has surrounding whitespace, or contains control characters.
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidIdempotencyKey> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_KEY_BYTES
            || value.trim() != value
            || value.chars().any(char::is_control)
        {
            return Err(InvalidIdempotencyKey);
        }
        Ok(Self(value))
    }

    /// Returns the validated key value.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for IdempotencyKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// An invalid caller-supplied idempotency key.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error(
    "idempotency key must be 1..=255 bytes, have no surrounding whitespace, and contain no control characters"
)]
pub struct InvalidIdempotencyKey;

/// Durable result of one successful remember operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RememberIdempotencyRecord {
    pub(crate) kind: String,
    pub(crate) memory_id: String,
    pub(crate) request_hash: blake3::Hash,
}

impl RememberIdempotencyRecord {
    pub(crate) fn new(memory_id: String, request_hash: blake3::Hash) -> Self {
        Self {
            kind: REMEMBER_KIND.to_owned(),
            memory_id,
            request_hash,
        }
    }

    pub(crate) fn durable_key(tenant_id: &TenantId, key: &IdempotencyKey) -> Vec<u8> {
        let mut hasher = blake3::Hasher::new();
        write_hash_field(&mut hasher, b"tenant_id", tenant_id.as_str().as_bytes());
        write_hash_field(&mut hasher, b"idempotency_key", key.as_str().as_bytes());
        format!("{REMEMBER_KEY_PREFIX}{}", hasher.finalize().to_hex()).into_bytes()
    }

    pub(crate) fn to_record(&self, tenant_id: &TenantId, key: &IdempotencyKey) -> Record {
        Record::new(
            Self::durable_key(tenant_id, key),
            Value::Object(BTreeMap::from([
                ("kind".to_owned(), Value::String(self.kind.clone())),
                (
                    "memory_id".to_owned(),
                    Value::String(self.memory_id.clone()),
                ),
                (
                    "request_hash".to_owned(),
                    Value::String(self.request_hash.to_hex().to_string()),
                ),
            ])),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, IdempotencyDecodeError> {
        if !record.key.starts_with(REMEMBER_KEY_PREFIX.as_bytes()) {
            return Err(IdempotencyDecodeError::Key);
        }
        let Value::Object(fields) = &record.value else {
            return Err(IdempotencyDecodeError::Field { field: "(root)" });
        };
        let kind = string_field(fields, "kind")?;
        if kind != REMEMBER_KIND {
            return Err(IdempotencyDecodeError::Field { field: "kind" });
        }
        let request_hash =
            blake3::Hash::from_hex(string_field(fields, "request_hash")?).map_err(|_| {
                IdempotencyDecodeError::Field {
                    field: "request_hash",
                }
            })?;
        Ok(Self {
            kind,
            memory_id: string_field(fields, "memory_id")?,
            request_hash,
        })
    }
}

/// Failure decoding a durable idempotency record.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum IdempotencyDecodeError {
    /// The durable key is outside the remember-idempotency namespace.
    #[error("record key is not a remember idempotency key")]
    Key,
    /// A required field is missing, mistyped, or invalid.
    #[error("idempotency document field `{field}` is missing, mistyped, or invalid")]
    Field {
        /// Offending field name.
        field: &'static str,
    },
}

/// Hashes the stable, effective inputs to a remember operation.
///
/// Generated identifiers and ingestion, creation, and retrieval clocks are
/// deliberately excluded. The caller-provided event time remains part of the
/// request identity.
pub(crate) fn canonical_remember_hash(memory: &Memory, vector: &Q15Vector) -> blake3::Hash {
    let mut hasher = blake3::Hasher::new();
    hasher.update(REQUEST_HASH_DOMAIN);
    write_hash_field(&mut hasher, b"content", memory.content.as_bytes());
    write_identity(&mut hasher, memory);
    write_provenance(&mut hasher, memory);
    write_optional_i64(&mut hasher, b"event_at_ms", memory.event_at_ms);
    write_hash_field(&mut hasher, b"scope", memory.scope.as_str().as_bytes());
    write_hash_field(
        &mut hasher,
        b"memory_type",
        memory.memory_type.as_str().as_bytes(),
    );
    write_hash_field(
        &mut hasher,
        b"importance_nanos",
        &scalar_nanos(memory.importance).to_le_bytes(),
    );
    write_hash_field(
        &mut hasher,
        b"pleasure_nanos",
        &scalar_nanos(memory.pad.pleasure).to_le_bytes(),
    );
    write_hash_field(
        &mut hasher,
        b"arousal_nanos",
        &scalar_nanos(memory.pad.arousal).to_le_bytes(),
    );
    write_hash_field(
        &mut hasher,
        b"dominance_nanos",
        &scalar_nanos(memory.pad.dominance).to_le_bytes(),
    );
    for tag in &memory.tags {
        write_hash_field(&mut hasher, b"tag", tag.as_bytes());
    }
    write_embedding(&mut hasher, memory, vector);
    hasher.finalize()
}

/// Derives the stable UUID assigned to an idempotent remember operation.
pub(crate) fn deterministic_remember_uuid(tenant_id: &TenantId, key: &IdempotencyKey) -> Uuid {
    let mut hasher = blake3::Hasher::new();
    hasher.update(UUID_DOMAIN);
    write_hash_field(&mut hasher, b"tenant_id", tenant_id.as_str().as_bytes());
    write_hash_field(&mut hasher, b"idempotency_key", key.as_str().as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn write_identity(hasher: &mut blake3::Hasher, memory: &Memory) {
    let identity = &memory.identity;
    write_hash_field(hasher, b"tenant_id", identity.tenant_id.as_str().as_bytes());
    write_hash_field(hasher, b"user_id", identity.user_id.as_str().as_bytes());
    write_optional_text(
        hasher,
        b"agent_id",
        identity.agent_id.as_ref().map(|value| value.as_str()),
    );
    write_optional_text(
        hasher,
        b"project_id",
        identity.project_id.as_ref().map(|value| value.as_str()),
    );
    write_optional_text(
        hasher,
        b"conversation_id",
        identity
            .conversation_id
            .as_ref()
            .map(|value| value.as_str()),
    );
    write_optional_text(
        hasher,
        b"session_id",
        identity.session_id.as_ref().map(|value| value.as_str()),
    );
}

fn write_provenance(hasher: &mut blake3::Hasher, memory: &Memory) {
    let provenance = &memory.provenance;
    write_hash_field(
        hasher,
        b"source_kind",
        provenance.source_kind.as_str().as_bytes(),
    );
    write_optional_text(
        hasher,
        b"source_namespace",
        provenance.source_namespace.as_deref(),
    );
    write_optional_text(hasher, b"source_id", provenance.source_id.as_deref());
    write_optional_text(hasher, b"event_id", provenance.event_id.as_deref());
    write_optional_text(hasher, b"turn_id", provenance.turn_id.as_deref());
    write_optional_text(hasher, b"source_uri", provenance.source_uri.as_deref());
    write_optional_text(hasher, b"source_actor", provenance.actor.as_deref());
    write_hash_field(hasher, b"content_hash", provenance.content_hash.as_bytes());
}

fn write_embedding(hasher: &mut blake3::Hasher, memory: &Memory, vector: &Q15Vector) {
    match &memory.embedding_space {
        Some(space) => {
            write_hash_field(hasher, b"embedding_present", &[1]);
            write_hash_field(hasher, b"embedding_provider", space.provider.as_bytes());
            write_hash_field(hasher, b"embedding_model", space.model.as_bytes());
            write_hash_field(hasher, b"embedding_revision", space.revision.as_bytes());
            write_hash_field(
                hasher,
                b"embedding_dimension",
                &space.dimension.to_le_bytes(),
            );
            write_hash_field(
                hasher,
                b"embedding_normalization",
                space.normalization.as_str().as_bytes(),
            );
        }
        None => write_hash_field(hasher, b"embedding_present", &[0]),
    }
    write_hash_field(
        hasher,
        b"vector_dimension",
        &(vector.as_slice().len() as u64).to_le_bytes(),
    );
    for component in vector.as_slice() {
        write_hash_field(hasher, b"q15", &component.to_le_bytes());
    }
}

fn write_optional_text(hasher: &mut blake3::Hasher, name: &[u8], value: Option<&str>) {
    match value {
        Some(value) => {
            write_hash_field(hasher, name, &[1]);
            write_hash_field(hasher, name, value.as_bytes());
        }
        None => write_hash_field(hasher, name, &[0]),
    }
}

fn write_optional_i64(hasher: &mut blake3::Hasher, name: &[u8], value: Option<i64>) {
    match value {
        Some(value) => {
            write_hash_field(hasher, name, &[1]);
            write_hash_field(hasher, name, &value.to_le_bytes());
        }
        None => write_hash_field(hasher, name, &[0]),
    }
}

fn write_hash_field(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn scalar_nanos(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value * NANOS).round() as i64
    }
}

fn string_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<String, IdempotencyDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(IdempotencyDecodeError::Field { field }),
    }
}

#[cfg(test)]
mod tests {
    use celiums_cognition::{MemoryState, MemoryType, Pad, Scope};

    use super::*;
    use crate::{
        EmbeddingNormalization, EmbeddingSpaceIdentity, MemoryIdentity, Provenance, SourceKind,
        UserId,
    };

    fn sample_memory() -> Memory {
        let content = "A stable observation";
        Memory {
            id: "generated-id".to_owned(),
            schema_version: 1,
            revision: 1,
            identity: MemoryIdentity {
                tenant_id: TenantId::new("tenant-a").expect("tenant"),
                user_id: UserId::new("user-a").expect("user"),
                agent_id: None,
                project_id: None,
                conversation_id: None,
                session_id: None,
            },
            provenance: Provenance::observed(
                SourceKind::User,
                content,
                Some("message-1".to_owned()),
                None,
                Some("Mario".to_owned()),
            ),
            embedding_space: Some(
                EmbeddingSpaceIdentity::new(
                    "workers-ai",
                    "bge-m3",
                    "v1",
                    3,
                    EmbeddingNormalization::L2,
                )
                .expect("embedding space"),
            ),
            vector: Some(hyphae_core::Q15Vector::new(vec![32_767, 1, 1]).expect("vector")),
            governance: None,
            content: content.to_owned(),
            importance: 0.75,
            pad: Pad {
                pleasure: 0.1,
                arousal: 0.2,
                dominance: 0.3,
            },
            strength: 1.0,
            retrieval_count: 0,
            memory_type: MemoryType::Episodic,
            state: MemoryState::Active,
            scope: Scope::Global,
            tags: vec!["stable".to_owned()],
            entities: Vec::new(),
            consolidation_count: 0,
            created_at_ms: 10,
            updated_at_ms: 10,
            event_at_ms: Some(5),
            ingested_at_ms: 10,
            last_retrieved_at_ms: 10,
        }
    }

    #[test]
    fn key_validation_enforces_canonical_boundary() {
        assert!(IdempotencyKey::new("").is_err());
        assert!(IdempotencyKey::new(" key").is_err());
        assert!(IdempotencyKey::new("key ").is_err());
        assert!(IdempotencyKey::new("bad\nkey").is_err());
        assert!(IdempotencyKey::new("x".repeat(256)).is_err());
        assert!(IdempotencyKey::new("x".repeat(255)).is_ok());
        assert_eq!(
            IdempotencyKey::new("request-1").expect("valid").as_str(),
            "request-1"
        );
    }

    #[test]
    fn canonical_hash_is_stable_sensitive_and_ignores_generated_fields() {
        let memory = sample_memory();
        let vector = Q15Vector::new(vec![100, -200, 300]).expect("vector");
        let expected = canonical_remember_hash(&memory, &vector);

        let mut generated_changes = memory.clone();
        generated_changes.id = "another-id".to_owned();
        generated_changes.created_at_ms = 999;
        generated_changes.ingested_at_ms = 999;
        generated_changes.last_retrieved_at_ms = 999;
        assert_eq!(
            canonical_remember_hash(&generated_changes, &vector),
            expected
        );

        let mut changed = memory.clone();
        changed.importance = 0.76;
        assert_ne!(canonical_remember_hash(&changed, &vector), expected);
        changed = memory.clone();
        changed.event_at_ms = Some(6);
        assert_ne!(canonical_remember_hash(&changed, &vector), expected);
        let other_vector = Q15Vector::new(vec![100, -200, 301]).expect("vector");
        assert_ne!(canonical_remember_hash(&memory, &other_vector), expected);
    }

    #[test]
    fn record_codec_and_domain_identifiers_are_deterministic() {
        let tenant = TenantId::new("tenant-a").expect("tenant");
        let other_tenant = TenantId::new("tenant-b").expect("tenant");
        let key = IdempotencyKey::new("request-1").expect("key");
        let record_value =
            RememberIdempotencyRecord::new("memory-1".to_owned(), blake3::hash(b"request"));
        let record = record_value.to_record(&tenant, &key);

        assert_eq!(
            RememberIdempotencyRecord::from_record(&record).expect("decode"),
            record_value
        );
        assert!(record.key.starts_with(REMEMBER_KEY_PREFIX.as_bytes()));
        assert_ne!(
            RememberIdempotencyRecord::durable_key(&tenant, &key),
            RememberIdempotencyRecord::durable_key(&other_tenant, &key)
        );
        assert_eq!(
            deterministic_remember_uuid(&tenant, &key),
            deterministic_remember_uuid(&tenant, &key)
        );
        assert_ne!(
            deterministic_remember_uuid(&tenant, &key),
            deterministic_remember_uuid(&other_tenant, &key)
        );
    }
}
