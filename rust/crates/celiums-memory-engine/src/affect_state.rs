// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable affect state: the engine's PAD emotional state persisted as
//! a Hyphae record.
//!
//! The TypeScript engine kept this state in Valkey (with a distributed
//! Lua-scripted mutex). Here it is one more record in the same durable,
//! hash-chained store as the memories — no cache service, no lock
//! (single-writer `&mut self` serialises updates), and it survives
//! restarts with recovery evidence instead of an AOF file.

use std::collections::BTreeMap;

use celiums_cognition::Pad;
use hyphae_query::{Record, Value};

use crate::memory::{MemoryDecodeError, integer_field, nanos_field, nanos_value};

/// Reserved key for the affect-state record. The `__celiums/` prefix
/// cannot collide with memory ids, which are always UUID strings.
pub(crate) const AFFECT_STATE_KEY: &[u8] = b"__celiums/limbic_state";

/// The persisted affect state: a PAD point plus its last update time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AffectState {
    /// Current emotional state.
    pub pad: Pad,
    /// When the state was last updated, Unix milliseconds.
    pub updated_at_ms: i64,
}

impl AffectState {
    /// Encodes the state as a canonical Hyphae record.
    ///
    /// The record has no `content` field, so the lexical index never
    /// sees it, and no vector is ever attached, so semantic retrieval
    /// never returns it. It is invisible to recall by construction.
    pub fn to_record(&self) -> Record {
        let mut fields = BTreeMap::new();
        fields.insert("kind".to_owned(), Value::String("affect_state".to_owned()));
        fields.insert("pleasure".to_owned(), nanos_value(self.pad.pleasure));
        fields.insert("arousal".to_owned(), nanos_value(self.pad.arousal));
        fields.insert("dominance".to_owned(), nanos_value(self.pad.dominance));
        fields.insert(
            "updated_at_ms".to_owned(),
            Value::Integer(self.updated_at_ms),
        );
        Record::new(AFFECT_STATE_KEY.to_vec(), Value::Object(fields))
    }

    /// Decodes a stored affect-state record.
    ///
    /// # Errors
    ///
    /// Fails loudly on missing or mistyped fields, like the memory
    /// codec: a corrupted state must never silently reset to neutral.
    pub fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field { field: "(root)" });
        };
        Ok(Self {
            pad: Pad {
                pleasure: nanos_field(fields, "pleasure")?,
                arousal: nanos_field(fields, "arousal")?,
                dominance: nanos_field(fields, "dominance")?,
            },
            updated_at_ms: integer_field(fields, "updated_at_ms")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affect_state_round_trips() {
        let state = AffectState {
            pad: Pad {
                pleasure: -0.25,
                arousal: 0.6,
                dominance: 0.1,
            },
            updated_at_ms: 1_770_000_000_000,
        };
        let decoded = AffectState::from_record(&state.to_record()).expect("round trip");
        assert_eq!(decoded, state);
    }

    #[test]
    fn decode_rejects_a_memory_record() {
        let record = Record::new(
            AFFECT_STATE_KEY.to_vec(),
            Value::Object(BTreeMap::from([(
                "content".to_owned(),
                Value::String("not a state".to_owned()),
            )])),
        );
        assert!(AffectState::from_record(&record).is_err());
    }
}
