// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The agent journal: the model's first-person, per-agent, hash-chained
//! notebook, durable in the same store as the memories.
//!
//! Port of the `agent_journal` + `journal_supersession` contract
//! (`mcp/journal-tools.ts`). Chain semantics are identical — each entry
//! hashes `(id | agent_id | content | written_at | prev_hash)` and
//! links to the previous entry of the same agent; tampering breaks the
//! chain and `verify` reports exactly which entries broke. The hash is
//! BLAKE3 here instead of SHA-256: this store carries no TS rows (fresh
//! chains), and BLAKE3 is already the digest of the underlying log.
//!
//! Journal entries are invisible to memory recall by construction:
//! their text lives in `journal_content` (the memory lexical index
//! covers `content`) and their vectors live in the `journal` space
//! (memory retrieval queries the `memories` space).
//!
//! Not ported (later phases, server-side concerns): `session_id`
//! (the TS dispatcher generated a random UUID per call), `visibility`,
//! `referenced_user_memory`, `inherited_from` cross-agent reads.

use std::collections::BTreeMap;

use celiums_cognition::{JournalEntryType, SupersessionRelation};
use hyphae_query::{Record, Value};

use crate::memory::{MemoryDecodeError, integer_field, nanos_field, nanos_value};

/// Discriminator for journal entry records.
pub(crate) const JOURNAL_KIND: &str = "journal";
/// Discriminator for supersession link records.
pub(crate) const SUPERSESSION_KIND: &str = "journal_supersession";
/// Maximum stored length of `valence_reason` (journal-tools.ts:158).
pub(crate) const MAX_VALENCE_REASON_CHARS: usize = 500;

/// One journal entry.
#[derive(Clone, Debug, PartialEq)]
pub struct JournalEntry {
    /// Stable identifier (UUIDv7 string).
    pub id: String,
    /// Owning agent (P0 §3.1: journal isolation invariant).
    pub agent_id: String,
    /// Entry taxonomy.
    pub entry_type: JournalEntryType,
    /// First-person entry text.
    pub content: String,
    /// Causal predecessors (entry ids), used by arcs.
    pub preceded_by: Vec<String>,
    /// Honest valence in `[-1, 1]`, when provided.
    pub valence: Option<f64>,
    /// Short justification for the valence, ≤ 500 chars.
    pub valence_reason: Option<String>,
    /// Intrinsic importance (from the entry type).
    pub importance: f64,
    /// Free-form tags.
    pub tags: Vec<String>,
    /// Stable per-conversation grouping key.
    pub conversation_id: Option<String>,
    /// Write time, Unix milliseconds.
    pub written_at_ms: i64,
    /// Hash of the previous entry of this agent; `None` for genesis.
    pub prev_hash: Option<String>,
    /// This entry's chain hash (hex BLAKE3).
    pub hash: String,
}

/// One supersession link between two entries of the same agent.
#[derive(Clone, Debug, PartialEq)]
pub struct Supersession {
    /// Stable identifier (UUIDv7 string).
    pub id: String,
    /// Owning agent.
    pub agent_id: String,
    /// The entry being superseded.
    pub original_entry_id: String,
    /// The entry that supersedes it.
    pub new_entry_id: String,
    /// How the new entry relates to the original.
    pub relation: SupersessionRelation,
    /// Link time, Unix milliseconds.
    pub written_at_ms: i64,
}

/// Chain verification report for one agent
/// (journal-tools.ts:244-279).
#[derive(Clone, Debug, PartialEq)]
pub struct ChainReport {
    /// Verified agent.
    pub agent_id: String,
    /// Entries walked.
    pub total: u64,
    /// Whether every link held.
    pub valid: bool,
    /// Broken entries, in chain order.
    pub broken: Vec<BrokenLink>,
}

/// One broken chain link.
#[derive(Clone, Debug, PartialEq)]
pub struct BrokenLink {
    /// Offending entry id.
    pub entry_id: String,
    /// What broke, mirroring the TS reasons.
    pub reason: BrokenReason,
}

/// Why a chain link failed verification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrokenReason {
    /// `prev_hash` does not match the previous entry (insertion or
    /// deletion before this entry).
    PrevHashMismatch,
    /// The stored hash does not match the recomputed one (content or
    /// timestamp tampered).
    ContentTampered,
}

/// Chain hash of one entry:
/// `BLAKE3(id | agent_id | content | written_at_ms | prev_hash?)`,
/// hex-encoded. Same input layout as the TS chain
/// (journal-tools.ts:262-264) with milliseconds instead of ISO time.
pub fn chain_hash(
    id: &str,
    agent_id: &str,
    content: &str,
    written_at_ms: i64,
    prev_hash: Option<&str>,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(id.as_bytes());
    hasher.update(b"|");
    hasher.update(agent_id.as_bytes());
    hasher.update(b"|");
    hasher.update(content.as_bytes());
    hasher.update(b"|");
    hasher.update(written_at_ms.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(prev_hash.unwrap_or("").as_bytes());
    hasher.finalize().to_hex().to_string()
}

/// Binary record key of a journal entry: `journal/<agent>/<id>`.
///
/// Entry ids are UUIDv7, so keys sort chronologically within an agent
/// — the binary key order IS the chain order.
pub(crate) fn entry_key(agent_id: &str, entry_id: &str) -> Vec<u8> {
    format!("journal/{agent_id}/{entry_id}").into_bytes()
}

/// Key prefix that scans one agent's entries in chain order.
pub(crate) fn agent_prefix(agent_id: &str) -> Vec<u8> {
    format!("journal/{agent_id}/").into_bytes()
}

/// Binary record key of a supersession link.
pub(crate) fn supersession_key(agent_id: &str, link_id: &str) -> Vec<u8> {
    format!("journal-supersession/{agent_id}/{link_id}").into_bytes()
}

/// Key prefix that scans one agent's supersession links.
pub(crate) fn supersession_prefix(agent_id: &str) -> Vec<u8> {
    format!("journal-supersession/{agent_id}/").into_bytes()
}

impl JournalEntry {
    /// Encodes this entry as a canonical Hyphae record.
    ///
    /// The text field is `journal_content`, not `content`, so the
    /// memory lexical index never sees journal entries.
    pub fn to_record(&self) -> Record {
        let mut fields = BTreeMap::new();
        fields.insert("kind".to_owned(), Value::String(JOURNAL_KIND.to_owned()));
        fields.insert("agent_id".to_owned(), Value::String(self.agent_id.clone()));
        fields.insert(
            "entry_type".to_owned(),
            Value::String(self.entry_type.as_str().to_owned()),
        );
        fields.insert(
            "journal_content".to_owned(),
            Value::String(self.content.clone()),
        );
        fields.insert(
            "preceded_by".to_owned(),
            Value::Array(
                self.preceded_by
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        fields.insert(
            "valence".to_owned(),
            self.valence.map_or(Value::Null, nanos_value),
        );
        fields.insert(
            "valence_reason".to_owned(),
            self.valence_reason
                .clone()
                .map_or(Value::Null, Value::String),
        );
        fields.insert("importance".to_owned(), nanos_value(self.importance));
        fields.insert(
            "tags".to_owned(),
            Value::Array(self.tags.iter().cloned().map(Value::String).collect()),
        );
        fields.insert(
            "conversation_id".to_owned(),
            self.conversation_id
                .clone()
                .map_or(Value::Null, Value::String),
        );
        fields.insert(
            "written_at_ms".to_owned(),
            Value::Integer(self.written_at_ms),
        );
        fields.insert(
            "prev_hash".to_owned(),
            self.prev_hash.clone().map_or(Value::Null, Value::String),
        );
        fields.insert("hash".to_owned(), Value::String(self.hash.clone()));
        Record::new(entry_key(&self.agent_id, &self.id), Value::Object(fields))
    }

    /// Decodes a stored journal record.
    ///
    /// # Errors
    ///
    /// Fails loudly on any missing or mistyped field.
    pub fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field { field: "(root)" });
        };
        let key = String::from_utf8(record.key.clone()).map_err(|_| MemoryDecodeError::Key)?;
        let id = key
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .ok_or(MemoryDecodeError::Key)?
            .to_owned();
        Ok(Self {
            id,
            agent_id: string_field(fields, "agent_id")?,
            entry_type: JournalEntryType::parse(&string_field(fields, "entry_type")?).ok_or(
                MemoryDecodeError::Field {
                    field: "entry_type",
                },
            )?,
            content: string_field(fields, "journal_content")?,
            preceded_by: string_array_field(fields, "preceded_by")?,
            valence: optional_nanos_field(fields, "valence")?,
            valence_reason: optional_string_field(fields, "valence_reason")?,
            importance: nanos_field(fields, "importance")?,
            tags: string_array_field(fields, "tags")?,
            conversation_id: optional_string_field(fields, "conversation_id")?,
            written_at_ms: integer_field(fields, "written_at_ms")?,
            prev_hash: optional_string_field(fields, "prev_hash")?,
            hash: string_field(fields, "hash")?,
        })
    }
}

impl Supersession {
    /// Encodes this link as a canonical Hyphae record.
    pub fn to_record(&self) -> Record {
        let mut fields = BTreeMap::new();
        fields.insert(
            "kind".to_owned(),
            Value::String(SUPERSESSION_KIND.to_owned()),
        );
        fields.insert("agent_id".to_owned(), Value::String(self.agent_id.clone()));
        fields.insert(
            "original_entry_id".to_owned(),
            Value::String(self.original_entry_id.clone()),
        );
        fields.insert(
            "new_entry_id".to_owned(),
            Value::String(self.new_entry_id.clone()),
        );
        fields.insert(
            "relation".to_owned(),
            Value::String(self.relation.as_str().to_owned()),
        );
        fields.insert(
            "written_at_ms".to_owned(),
            Value::Integer(self.written_at_ms),
        );
        Record::new(
            supersession_key(&self.agent_id, &self.id),
            Value::Object(fields),
        )
    }

    /// Decodes a stored supersession record.
    ///
    /// # Errors
    ///
    /// Fails loudly on any missing or mistyped field.
    pub fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = &record.value else {
            return Err(MemoryDecodeError::Field { field: "(root)" });
        };
        let key = String::from_utf8(record.key.clone()).map_err(|_| MemoryDecodeError::Key)?;
        let id = key
            .rsplit('/')
            .next()
            .filter(|segment| !segment.is_empty())
            .ok_or(MemoryDecodeError::Key)?
            .to_owned();
        Ok(Self {
            id,
            agent_id: string_field(fields, "agent_id")?,
            original_entry_id: string_field(fields, "original_entry_id")?,
            new_entry_id: string_field(fields, "new_entry_id")?,
            relation: SupersessionRelation::parse(&string_field(fields, "relation")?)
                .ok_or(MemoryDecodeError::Field { field: "relation" })?,
            written_at_ms: integer_field(fields, "written_at_ms")?,
        })
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
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(Value::Null) => Ok(None),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn optional_nanos_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<f64>, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(_)) => nanos_field(fields, field).map(Some),
        Some(Value::Null) => Ok(None),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn string_array_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<String>, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(item) => Ok(item.clone()),
                _ => Err(MemoryDecodeError::Field { field }),
            })
            .collect(),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> JournalEntry {
        let id = "0195f0a2-2222-7000-8000-000000000001";
        let agent = "Codex-opus-4-8";
        let content = "Decidí portar el journal sobre Hyphae.";
        let written = 1_770_000_000_000;
        let hash = chain_hash(id, agent, content, written, None);
        JournalEntry {
            id: id.to_owned(),
            agent_id: agent.to_owned(),
            entry_type: JournalEntryType::Decision,
            content: content.to_owned(),
            preceded_by: vec!["0195f0a2-1111-7000-8000-000000000009".to_owned()],
            valence: Some(0.7),
            valence_reason: Some("salió limpio".to_owned()),
            importance: JournalEntryType::Decision.importance(),
            tags: vec!["port".to_owned()],
            conversation_id: None,
            written_at_ms: written,
            prev_hash: None,
            hash,
        }
    }

    #[test]
    fn journal_entry_round_trips() {
        let entry = sample();
        let decoded = JournalEntry::from_record(&entry.to_record()).expect("round trip");
        assert_eq!(decoded, entry);
    }

    #[test]
    fn optional_fields_round_trip_as_null() {
        let mut entry = sample();
        entry.valence = None;
        entry.valence_reason = None;
        entry.conversation_id = None;
        let decoded = JournalEntry::from_record(&entry.to_record()).expect("round trip");
        assert_eq!(decoded, entry);
    }

    #[test]
    fn chain_hash_changes_with_every_component() {
        let base = chain_hash("id", "agent", "content", 1000, None);
        assert_ne!(base, chain_hash("id2", "agent", "content", 1000, None));
        assert_ne!(base, chain_hash("id", "agent2", "content", 1000, None));
        assert_ne!(base, chain_hash("id", "agent", "tampered", 1000, None));
        assert_ne!(base, chain_hash("id", "agent", "content", 1001, None));
        assert_ne!(
            base,
            chain_hash("id", "agent", "content", 1000, Some(&base))
        );
        // Deterministic.
        assert_eq!(base, chain_hash("id", "agent", "content", 1000, None));
    }

    #[test]
    fn supersession_round_trips() {
        let link = Supersession {
            id: "0195f0a2-3333-7000-8000-000000000001".to_owned(),
            agent_id: "Codex-opus-4-8".to_owned(),
            original_entry_id: "a".to_owned(),
            new_entry_id: "b".to_owned(),
            relation: SupersessionRelation::Recanted,
            written_at_ms: 1_770_000_000_000,
        };
        let decoded = Supersession::from_record(&link.to_record()).expect("round trip");
        assert_eq!(decoded, link);
    }

    #[test]
    fn keys_scan_in_chain_order_within_an_agent() {
        let earlier = entry_key("agent", "0195f0a2-0000-7000-8000-000000000001");
        let later = entry_key("agent", "0195f0a2-ffff-7000-8000-000000000001");
        assert!(earlier < later, "UUIDv7 keys must sort chronologically");
        let prefix = agent_prefix("agent");
        assert!(earlier.starts_with(&prefix) && later.starts_with(&prefix));
    }
}
