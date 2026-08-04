// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The entity index: the reverse edge of the memory graph.
//!
//! Each memory stores the entities it binds to (hippocampal binding,
//! `Memory.entities`). This module maintains the reverse direction —
//! entity → memory ids — as one durable record per entity, keyed
//! `entity/<kind>/<name>`. Together they form a queryable bipartite
//! graph with zero graph-database infrastructure.

use std::collections::BTreeMap;

use celiums_cognition::EntityKind;
use hyphae_query::{Record, Value};

use crate::memory::{MemoryDecodeError, nanos_field, nanos_value};

/// Discriminator for entity index records.
pub(crate) const ENTITY_KIND: &str = "entity";

/// One entity with the memories bound to it.
#[derive(Clone, Debug, PartialEq)]
pub struct EntityRecord {
    /// Canonical (lowercased) entity name.
    pub name: String,
    /// Extractor kind.
    pub kind: EntityKind,
    /// Highest salience observed for this entity.
    pub salience: f64,
    /// Ids of memories bound to this entity, in binding order.
    pub memory_ids: Vec<String>,
}

/// Binary record key of an entity: `entity/<kind>/<name>`.
pub(crate) fn entity_key(kind: EntityKind, name: &str) -> Vec<u8> {
    format!("entity/{}/{}", kind.as_str(), name.to_lowercase()).into_bytes()
}

/// Key prefix that scans the whole entity index.
pub(crate) fn entity_prefix() -> Vec<u8> {
    b"entity/".to_vec()
}

impl EntityRecord {
    /// Encodes this entity as a canonical Hyphae record.
    pub fn to_record(&self) -> Record {
        let mut fields = BTreeMap::new();
        fields.insert("kind".to_owned(), Value::String(ENTITY_KIND.to_owned()));
        fields.insert("name".to_owned(), Value::String(self.name.clone()));
        fields.insert(
            "entity_kind".to_owned(),
            Value::String(self.kind.as_str().to_owned()),
        );
        fields.insert("salience".to_owned(), nanos_value(self.salience));
        fields.insert(
            "memory_ids".to_owned(),
            Value::Array(self.memory_ids.iter().cloned().map(Value::String).collect()),
        );
        Record::new(entity_key(self.kind, &self.name), Value::Object(fields))
    }

    /// Decodes a stored entity record.
    ///
    /// # Errors
    ///
    /// Fails loudly on any missing or mistyped field.
    pub fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field { field: "(root)" });
        };
        let name = match fields.get("name") {
            Some(Value::String(value)) => value.clone(),
            _ => return Err(MemoryDecodeError::Field { field: "name" }),
        };
        let kind = match fields.get("entity_kind") {
            Some(Value::String(value)) => {
                EntityKind::parse(value).ok_or(MemoryDecodeError::Field {
                    field: "entity_kind",
                })?
            }
            _ => {
                return Err(MemoryDecodeError::Field {
                    field: "entity_kind",
                });
            }
        };
        let memory_ids = match fields.get("memory_ids") {
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| match value {
                    Value::String(id) => Ok(id.clone()),
                    _ => Err(MemoryDecodeError::Field {
                        field: "memory_ids",
                    }),
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => {
                return Err(MemoryDecodeError::Field {
                    field: "memory_ids",
                });
            }
        };
        Ok(Self {
            name,
            kind,
            salience: nanos_field(fields, "salience")?,
            memory_ids,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_record_round_trips() {
        let entity = EntityRecord {
            name: "rust".to_owned(),
            kind: EntityKind::Technology,
            salience: 0.5,
            memory_ids: vec!["a".to_owned(), "b".to_owned()],
        };
        let decoded = EntityRecord::from_record(&entity.to_record()).expect("round trip");
        assert_eq!(decoded, entity);
    }

    #[test]
    fn keys_are_namespaced_by_kind_and_lowercased() {
        assert_eq!(
            entity_key(EntityKind::Person, "Mario Gutierrez"),
            b"entity/person/mario gutierrez".to_vec()
        );
        assert!(entity_key(EntityKind::Technology, "rust").starts_with(&entity_prefix()));
    }
}
