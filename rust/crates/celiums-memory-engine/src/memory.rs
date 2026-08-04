// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The durable memory record and its canonical Hyphae document codec.
//!
//! Hyphae documents deliberately have no float type (deterministic
//! total ordering), so every cognitive scalar is stored as integer
//! nanos (`value * 1e9`), the same convention Hyphae itself uses for
//! scores.

use std::collections::BTreeMap;

use celiums_cognition::{MemoryType, Pad, Scope};
use hyphae_query::{Record, Value};
use thiserror::Error;

/// Nanos scale shared with Hyphae score semantics.
const NANOS: f64 = 1_000_000_000.0;

/// One durable memory with its cognitive metadata.
#[derive(Clone, Debug, PartialEq)]
pub struct Memory {
    /// Stable identifier (UUID string; also the binary record key).
    pub id: String,
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
    /// Visibility scope.
    pub scope: Scope,
    /// Free-form tags.
    pub tags: Vec<String>,
    /// Creation time, Unix milliseconds.
    pub created_at_ms: i64,
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
            "scope".to_owned(),
            Value::String(self.scope.as_str().to_owned()),
        );
        fields.insert(
            "tags".to_owned(),
            Value::Array(self.tags.iter().cloned().map(Value::String).collect()),
        );
        fields.insert(
            "created_at_ms".to_owned(),
            Value::Integer(self.created_at_ms),
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
        Ok(Self {
            id,
            content: string_field(fields, "content")?,
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
            scope: Scope::parse(&string_field(fields, "scope")?)
                .ok_or(MemoryDecodeError::Field { field: "scope" })?,
            tags: tags_field(fields)?,
            created_at_ms: integer_field(fields, "created_at_ms")?,
            last_retrieved_at_ms: integer_field(fields, "last_retrieved_at_ms")?,
        })
    }
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
            scope: Scope::Project,
            tags: vec!["rust".to_owned(), "decision".to_owned()],
            created_at_ms: 1_770_000_000_000,
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
}
