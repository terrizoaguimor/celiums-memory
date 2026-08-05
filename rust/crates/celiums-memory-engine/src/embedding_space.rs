// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable identity of the embedding space used by one engine.

use std::collections::BTreeMap;

use hyphae_query::{Record, Value};
use thiserror::Error;

use crate::memory::MemoryDecodeError;

/// Internal record key that binds a store to one embedding space.
pub(crate) const EMBEDDING_SPACE_KEY: &[u8] = b"__celiums/embedding_space";

/// Invalid embedding-space metadata.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum InvalidEmbeddingSpace {
    /// A required identity component was empty or contained controls.
    #[error("embedding {field} must be 1..=255 bytes and contain no control characters")]
    Text {
        /// Invalid component.
        field: &'static str,
    },
    /// Dimension must be supported by the canonical Q15 domain.
    #[error("embedding dimension must be between 1 and 4096")]
    Dimension,
}

/// Vector normalization applied before canonical Q15 quantization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EmbeddingNormalization {
    /// Input vectors are L2 normalized.
    L2,
}

impl EmbeddingNormalization {
    /// Stable serialized name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::L2 => "l2",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "l2" => Some(Self::L2),
            _ => None,
        }
    }
}

/// Complete identity of a compatible embedding vector space.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmbeddingSpaceIdentity {
    /// Provider or runtime that produced vectors.
    pub provider: String,
    /// Model name.
    pub model: String,
    /// Immutable model or tokenizer revision.
    pub revision: String,
    /// Vector dimension.
    pub dimension: u16,
    /// Vector normalization contract.
    pub normalization: EmbeddingNormalization,
}

impl EmbeddingSpaceIdentity {
    /// Validates a complete embedding-space identity.
    pub fn new(
        provider: impl Into<String>,
        model: impl Into<String>,
        revision: impl Into<String>,
        dimension: u16,
        normalization: EmbeddingNormalization,
    ) -> Result<Self, InvalidEmbeddingSpace> {
        let provider = validate_text(provider.into(), "provider")?;
        let model = validate_text(model.into(), "model")?;
        let revision = validate_text(revision.into(), "revision")?;
        if !(1..=4096).contains(&dimension) {
            return Err(InvalidEmbeddingSpace::Dimension);
        }
        Ok(Self {
            provider,
            model,
            revision,
            dimension,
            normalization,
        })
    }

    /// Identity of the built-in deterministic word/bigram hash embedder.
    pub fn deterministic(dimension: u16) -> Self {
        Self::new(
            "celiums",
            "deterministic-word-bigram-hash",
            "v1",
            dimension,
            EmbeddingNormalization::L2,
        )
        .expect("validated dimension")
    }

    pub(crate) fn to_record(&self) -> Record {
        Record::new(
            EMBEDDING_SPACE_KEY.to_vec(),
            Value::Object(BTreeMap::from([
                (
                    "kind".to_owned(),
                    Value::String("embedding_space".to_owned()),
                ),
                ("provider".to_owned(), Value::String(self.provider.clone())),
                ("model".to_owned(), Value::String(self.model.clone())),
                ("revision".to_owned(), Value::String(self.revision.clone())),
                (
                    "dimension".to_owned(),
                    Value::Integer(i64::from(self.dimension)),
                ),
                (
                    "normalization".to_owned(),
                    Value::String(self.normalization.as_str().to_owned()),
                ),
            ])),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field {
                field: "embedding_space",
            });
        };
        let string = |field: &'static str| match fields.get(field) {
            Some(Value::String(value)) => Ok(value.clone()),
            _ => Err(MemoryDecodeError::Field { field }),
        };
        let dimension = match fields.get("dimension") {
            Some(Value::Integer(value)) => u16::try_from(*value)
                .map_err(|_| MemoryDecodeError::Field { field: "dimension" })?,
            _ => return Err(MemoryDecodeError::Field { field: "dimension" }),
        };
        let normalization = EmbeddingNormalization::parse(&string("normalization")?).ok_or(
            MemoryDecodeError::Field {
                field: "normalization",
            },
        )?;
        Self::new(
            string("provider")?,
            string("model")?,
            string("revision")?,
            dimension,
            normalization,
        )
        .map_err(|_| MemoryDecodeError::Field {
            field: "embedding_space",
        })
    }
}

fn validate_text(value: String, field: &'static str) -> Result<String, InvalidEmbeddingSpace> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > 255
        || value.chars().any(char::is_control)
    {
        return Err(InvalidEmbeddingSpace::Text { field });
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_round_trips_through_record() {
        let identity = EmbeddingSpaceIdentity::new(
            "workers-ai",
            "bge-m3",
            "2026-06",
            1024,
            EmbeddingNormalization::L2,
        )
        .expect("identity");
        assert_eq!(
            EmbeddingSpaceIdentity::from_record(&identity.to_record()).expect("decode"),
            identity
        );
    }

    #[test]
    fn identity_rejects_ambiguous_components_and_dimensions() {
        assert!(
            EmbeddingSpaceIdentity::new(
                " workers-ai",
                "bge-m3",
                "v1",
                1024,
                EmbeddingNormalization::L2,
            )
            .is_err()
        );
        assert!(
            EmbeddingSpaceIdentity::new(
                "workers-ai",
                "bge-m3",
                "v1",
                0,
                EmbeddingNormalization::L2,
            )
            .is_err()
        );
    }
}
