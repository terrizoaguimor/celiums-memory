// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable circadian state: factor accumulators, the VPN-immune
//! activity histogram, and the timezone configuration, persisted as
//! one Hyphae record.
//!
//! This is what gives the rhythm continuity with the user: the TS
//! engine kept factors in process memory (they vanished on restart)
//! and the histogram in Postgres. Here both live in the same durable,
//! hash-chained store as the memories — an engine reopened after a
//! week knows the user's rhythm and how tired it should feel.

use std::collections::BTreeMap;

use celiums_cognition::CircadianFactors;
use hyphae_query::{Record, Value};

use crate::memory::{MemoryDecodeError, integer_field, nanos_field, nanos_value};

/// Reserved key for the circadian-state record.
pub(crate) const CIRCADIAN_STATE_KEY: &[u8] = b"__celiums/circadian_state";

/// The persisted circadian state.
#[derive(Clone, Debug, PartialEq)]
pub struct CircadianState {
    /// Decaying factor accumulators as of `updated_at_ms`.
    pub factors: CircadianFactors,
    /// 24-bucket interaction histogram indexed by UTC hour — the
    /// behavioural timezone signal. Only genuine activity moves it.
    pub activity_histogram: [u32; 24],
    /// Explicit UTC offset in minutes, when the operator configured
    /// one. Wins over the inferred rhythm.
    pub timezone_override_minutes: Option<i32>,
    /// Last interaction time, Unix milliseconds.
    pub last_interaction_ms: i64,
    /// When this state was written, Unix milliseconds.
    pub updated_at_ms: i64,
}

impl CircadianState {
    /// A fresh state for a new engine.
    pub fn new(timezone_override_minutes: Option<i32>) -> Self {
        Self {
            factors: CircadianFactors::default(),
            activity_histogram: [0; 24],
            timezone_override_minutes,
            last_interaction_ms: 0,
            updated_at_ms: 0,
        }
    }

    /// Encodes the state as a canonical Hyphae record. Like the affect
    /// state, it has no `content` field and no vector: invisible to
    /// recall by construction.
    pub fn to_record(&self) -> Record {
        let mut fields = BTreeMap::new();
        fields.insert(
            "kind".to_owned(),
            Value::String("circadian_state".to_owned()),
        );
        let factors = &self.factors;
        for (name, value) in [
            ("session_activity", factors.session_activity),
            ("stress_level", factors.stress_level),
            ("social_signal", factors.social_signal),
            ("caffeine_level", factors.caffeine_level),
            ("sleep_debt", factors.sleep_debt),
            ("cognitive_load", factors.cognitive_load),
            ("emotional_accumulator", factors.emotional_accumulator),
            ("exercise_level", factors.exercise_level),
            ("motivation_trend", factors.motivation_trend),
        ] {
            fields.insert(name.to_owned(), nanos_value(value));
        }
        fields.insert(
            "activity_histogram".to_owned(),
            Value::Array(
                self.activity_histogram
                    .iter()
                    .map(|count| Value::Integer(i64::from(*count)))
                    .collect(),
            ),
        );
        fields.insert(
            "timezone_override_minutes".to_owned(),
            self.timezone_override_minutes
                .map_or(Value::Null, |minutes| Value::Integer(i64::from(minutes))),
        );
        fields.insert(
            "last_interaction_ms".to_owned(),
            Value::Integer(self.last_interaction_ms),
        );
        fields.insert(
            "updated_at_ms".to_owned(),
            Value::Integer(self.updated_at_ms),
        );
        Record::new(CIRCADIAN_STATE_KEY.to_vec(), Value::Object(fields))
    }

    /// Decodes a stored circadian-state record.
    ///
    /// # Errors
    ///
    /// Fails loudly on missing or mistyped fields — a corrupted rhythm
    /// must never silently reset.
    pub fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field { field: "(root)" });
        };
        let mut activity_histogram = [0u32; 24];
        match fields.get("activity_histogram") {
            Some(Value::Array(values)) if values.len() == 24 => {
                for (bucket, value) in activity_histogram.iter_mut().zip(values) {
                    let Value::Integer(count) = value else {
                        return Err(MemoryDecodeError::Field {
                            field: "activity_histogram",
                        });
                    };
                    *bucket = u32::try_from(*count).map_err(|_| MemoryDecodeError::Field {
                        field: "activity_histogram",
                    })?;
                }
            }
            _ => {
                return Err(MemoryDecodeError::Field {
                    field: "activity_histogram",
                });
            }
        }
        let timezone_override_minutes = match fields.get("timezone_override_minutes") {
            Some(Value::Integer(minutes)) => {
                Some(
                    i32::try_from(*minutes).map_err(|_| MemoryDecodeError::Field {
                        field: "timezone_override_minutes",
                    })?,
                )
            }
            Some(Value::Null) => None,
            _ => {
                return Err(MemoryDecodeError::Field {
                    field: "timezone_override_minutes",
                });
            }
        };
        Ok(Self {
            factors: CircadianFactors {
                session_activity: nanos_field(fields, "session_activity")?,
                stress_level: nanos_field(fields, "stress_level")?,
                social_signal: nanos_field(fields, "social_signal")?,
                caffeine_level: nanos_field(fields, "caffeine_level")?,
                sleep_debt: nanos_field(fields, "sleep_debt")?,
                cognitive_load: nanos_field(fields, "cognitive_load")?,
                emotional_accumulator: nanos_field(fields, "emotional_accumulator")?,
                exercise_level: nanos_field(fields, "exercise_level")?,
                motivation_trend: nanos_field(fields, "motivation_trend")?,
            },
            activity_histogram,
            timezone_override_minutes,
            last_interaction_ms: integer_field(fields, "last_interaction_ms")?,
            updated_at_ms: integer_field(fields, "updated_at_ms")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circadian_state_round_trips() {
        let mut state = CircadianState::new(Some(-300));
        state.factors.caffeine_level = 0.4;
        state.factors.sleep_debt = 0.25;
        state.activity_histogram[14] = 42;
        state.last_interaction_ms = 1_770_000_000_000;
        state.updated_at_ms = 1_770_000_000_000;
        let decoded = CircadianState::from_record(&state.to_record()).expect("round trip");
        assert_eq!(decoded, state);
    }

    #[test]
    fn no_override_round_trips_as_null() {
        let state = CircadianState::new(None);
        let decoded = CircadianState::from_record(&state.to_record()).expect("round trip");
        assert_eq!(decoded.timezone_override_minutes, None);
    }

    #[test]
    fn decode_rejects_wrong_histogram_shape() {
        let mut record = CircadianState::new(None).to_record();
        if let Value::Object(fields) = &mut record.value {
            fields.insert(
                "activity_histogram".to_owned(),
                Value::Array(vec![Value::Integer(1); 23]),
            );
        }
        assert!(CircadianState::from_record(&record).is_err());
    }
}
