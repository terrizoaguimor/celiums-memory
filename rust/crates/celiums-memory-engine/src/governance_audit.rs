// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable, content-free ethics audit and review records.
//!
//! Audit entries form one append-only BLAKE3 chain per tenant. The records
//! retain identifiers, policy metadata, classifications, and decisions, but
//! deliberately never retain the governed content. Feedback is append-only as
//! well: resolving feedback creates a separate [`FeedbackResolution`] record.

#![allow(dead_code)] // This staged module is intentionally not wired into the engine yet.

use std::collections::BTreeMap;

use hyphae_query::{Record, Value};

use crate::memory::MemoryDecodeError;

const AUDIT_KIND: &str = "ethics_audit";
const FEEDBACK_KIND: &str = "ethics_feedback";
const FEEDBACK_RESOLUTION_KIND: &str = "ethics_feedback_resolution";
const AUDIT_KEY_PREFIX: &str = "__celiums/ethics_audit/";
const FEEDBACK_KEY_PREFIX: &str = "__celiums/ethics_feedback/";
const AUDIT_HASH_DOMAIN: &[u8] = b"celiums-memory/ethics-audit/v1";

/// A memory operation governed by an ethics policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GovernedOperation {
    /// Accept an observation at the ingestion boundary.
    Ingest,
    /// Persist an accepted observation.
    Store,
    /// Select a memory as a recall candidate.
    Recall,
    /// Disclose a recalled memory to a caller.
    Disclose,
    /// Change a memory or its governance metadata.
    Update,
    /// Remove a memory.
    Delete,
}

impl GovernedOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ingest => "ingest",
            Self::Store => "store",
            Self::Recall => "recall",
            Self::Disclose => "disclose",
            Self::Update => "update",
            Self::Delete => "delete",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "ingest" => Some(Self::Ingest),
            "store" => Some(Self::Store),
            "recall" => Some(Self::Recall),
            "disclose" => Some(Self::Disclose),
            "update" => Some(Self::Update),
            "delete" => Some(Self::Delete),
            _ => None,
        }
    }
}

/// The durable outcome of a governed operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuditDecision {
    /// Permit the operation without transforming its result.
    Allow,
    /// Permit only a policy-safe summary.
    Summarize,
    /// Permit the result after removing protected details.
    Redact,
    /// Withhold the result from the current caller or purpose.
    Restrict,
    /// Decline to produce a result.
    Abstain,
    /// Isolate the subject pending review.
    Quarantine,
    /// Reject the operation.
    Reject,
}

impl AuditDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Summarize => "summarize",
            Self::Redact => "redact",
            Self::Restrict => "restrict",
            Self::Abstain => "abstain",
            Self::Quarantine => "quarantine",
            Self::Reject => "reject",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "summarize" => Some(Self::Summarize),
            "redact" => Some(Self::Redact),
            "restrict" => Some(Self::Restrict),
            "abstain" => Some(Self::Abstain),
            "quarantine" => Some(Self::Quarantine),
            "reject" => Some(Self::Reject),
            _ => None,
        }
    }
}

/// Review status captured when an audit decision is written.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewState {
    /// No review has been requested.
    Unreviewed,
    /// A review has been requested but not resolved.
    Pending,
    /// A reviewer has resolved the decision.
    Reviewed,
}

impl ReviewState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unreviewed => "unreviewed",
            Self::Pending => "pending",
            Self::Reviewed => "reviewed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "unreviewed" => Some(Self::Unreviewed),
            "pending" => Some(Self::Pending),
            "reviewed" => Some(Self::Reviewed),
            _ => None,
        }
    }
}

/// Classification of feedback about an ethics decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeedbackKind {
    /// Policy blocked or transformed a legitimate use.
    FalsePositive,
    /// Policy allowed a use that should have been governed.
    FalseNegative,
    /// A subject or operator requests reconsideration.
    Appeal,
    /// An operator reports incorrect audit metadata.
    Correction,
}

impl FeedbackKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::FalsePositive => "false_positive",
            Self::FalseNegative => "false_negative",
            Self::Appeal => "appeal",
            Self::Correction => "correction",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "false_positive" => Some(Self::FalsePositive),
            "false_negative" => Some(Self::FalseNegative),
            "appeal" => Some(Self::Appeal),
            "correction" => Some(Self::Correction),
            _ => None,
        }
    }
}

/// Outcome of a feedback review.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewDisposition {
    /// The original decision remains valid.
    Upheld,
    /// The original decision is reversed.
    Overturned,
    /// Part, but not all, of the original decision is reversed.
    PartiallyOverturned,
    /// The feedback is closed without deciding the original decision.
    Dismissed,
}

impl ReviewDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Upheld => "upheld",
            Self::Overturned => "overturned",
            Self::PartiallyOverturned => "partially_overturned",
            Self::Dismissed => "dismissed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "upheld" => Some(Self::Upheld),
            "overturned" => Some(Self::Overturned),
            "partially_overturned" => Some(Self::PartiallyOverturned),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }
}

/// One immutable ethics decision in a tenant's audit chain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EthicsAuditEntry {
    /// Stable identifier (UUIDv7 string).
    pub id: String,
    /// Tenant whose chain owns this entry.
    pub tenant_id: String,
    /// Governed operation.
    pub operation: GovernedOperation,
    /// Opaque identifier of the governed memory or request.
    pub subject_id: String,
    /// Optional digest of the governed content, never the content itself.
    pub content_digest: Option<String>,
    /// Declared purpose for the operation.
    pub purpose: String,
    /// Treatment applied to the subject, such as `restricted`.
    pub treatment: String,
    /// Stable policy identifier.
    pub policy_id: String,
    /// Exact policy version that produced the decision.
    pub policy_version: String,
    /// Policy outcome.
    pub decision: AuditDecision,
    /// Machine-readable policy reason codes.
    pub reason_codes: Vec<String>,
    /// Review status at decision time.
    pub review_state: ReviewState,
    /// Optional actor identifier; no actor-provided text is retained.
    pub actor_id: Option<String>,
    /// Decision time, Unix milliseconds.
    pub occurred_at_ms: i64,
    /// Hash of the preceding entry in this tenant's chain.
    pub previous_hash: Option<String>,
    /// Hex BLAKE3 hash of this entry's stable fields and previous hash.
    pub hash: String,
}

/// Result of verifying one tenant's audit chain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuditChainReport {
    /// Tenant whose chain was checked.
    pub tenant_id: String,
    /// Number of supplied entries checked.
    pub total: u64,
    /// Whether every entry, tenant boundary, and chain link is valid.
    pub valid: bool,
    /// Entry identifiers whose hash, tenant, or previous link is invalid.
    pub broken_entry_ids: Vec<String>,
}

/// Immutable feedback about one audit decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedbackEntry {
    /// Stable identifier (UUIDv7 string).
    pub id: String,
    /// Tenant that owns the referenced audit decision.
    pub tenant_id: String,
    /// Referenced [`EthicsAuditEntry`] identifier.
    pub audit_entry_id: String,
    /// Feedback classification.
    pub kind: FeedbackKind,
    /// Machine-readable rationale code; raw feedback text is not stored.
    pub reason_code: String,
    /// Optional identifier of the submitter.
    pub submitted_by: Option<String>,
    /// Submission time, Unix milliseconds.
    pub submitted_at_ms: i64,
}

/// Immutable resolution appended for a [`FeedbackEntry`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedbackResolution {
    /// Stable identifier (UUIDv7 string), distinct from the feedback id.
    pub id: String,
    /// Tenant that owns the referenced feedback.
    pub tenant_id: String,
    /// Referenced [`FeedbackEntry`] identifier.
    pub feedback_entry_id: String,
    /// Review outcome.
    pub disposition: ReviewDisposition,
    /// Machine-readable resolution reason.
    pub reason_code: String,
    /// Optional reviewer identifier.
    pub reviewed_by: Option<String>,
    /// Resolution time, Unix milliseconds.
    pub resolved_at_ms: i64,
}

impl EthicsAuditEntry {
    /// Computes the canonical chain hash for this entry.
    pub fn compute_hash(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        hasher.update(AUDIT_HASH_DOMAIN);
        hash_text(&mut hasher, "id", &self.id);
        hash_text(&mut hasher, "tenant_id", &self.tenant_id);
        hash_text(&mut hasher, "operation", self.operation.as_str());
        hash_text(&mut hasher, "subject_id", &self.subject_id);
        hash_optional_text(
            &mut hasher,
            "content_digest",
            self.content_digest.as_deref(),
        );
        hash_text(&mut hasher, "purpose", &self.purpose);
        hash_text(&mut hasher, "treatment", &self.treatment);
        hash_text(&mut hasher, "policy_id", &self.policy_id);
        hash_text(&mut hasher, "policy_version", &self.policy_version);
        hash_text(&mut hasher, "decision", self.decision.as_str());
        for reason_code in &self.reason_codes {
            hash_text(&mut hasher, "reason_code", reason_code);
        }
        hash_text(&mut hasher, "review_state", self.review_state.as_str());
        hash_optional_text(&mut hasher, "actor_id", self.actor_id.as_deref());
        hash_bytes(
            &mut hasher,
            b"occurred_at_ms",
            &self.occurred_at_ms.to_le_bytes(),
        );
        hash_optional_text(&mut hasher, "previous_hash", self.previous_hash.as_deref());
        hasher.finalize().to_hex().to_string()
    }

    /// Encodes this entry as a canonical Hyphae record.
    pub(crate) fn to_record(&self) -> Record {
        let fields = BTreeMap::from([
            ("kind".to_owned(), Value::String(AUDIT_KIND.to_owned())),
            (
                "tenant_id".to_owned(),
                Value::String(self.tenant_id.clone()),
            ),
            (
                "operation".to_owned(),
                Value::String(self.operation.as_str().to_owned()),
            ),
            (
                "subject_id".to_owned(),
                Value::String(self.subject_id.clone()),
            ),
            (
                "content_digest".to_owned(),
                optional_string_value(&self.content_digest),
            ),
            ("purpose".to_owned(), Value::String(self.purpose.clone())),
            (
                "treatment".to_owned(),
                Value::String(self.treatment.clone()),
            ),
            (
                "policy_id".to_owned(),
                Value::String(self.policy_id.clone()),
            ),
            (
                "policy_version".to_owned(),
                Value::String(self.policy_version.clone()),
            ),
            (
                "decision".to_owned(),
                Value::String(self.decision.as_str().to_owned()),
            ),
            (
                "reason_codes".to_owned(),
                string_array_value(&self.reason_codes),
            ),
            (
                "review_state".to_owned(),
                Value::String(self.review_state.as_str().to_owned()),
            ),
            ("actor_id".to_owned(), optional_string_value(&self.actor_id)),
            (
                "occurred_at_ms".to_owned(),
                Value::Integer(self.occurred_at_ms),
            ),
            (
                "previous_hash".to_owned(),
                optional_string_value(&self.previous_hash),
            ),
            ("hash".to_owned(), Value::String(self.hash.clone())),
        ]);
        Record::new(audit_key(&self.id), Value::Object(fields))
    }

    /// Decodes an audit record, rejecting malformed keys and fields.
    pub(crate) fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let id = id_from_key(&record.key, AUDIT_KEY_PREFIX)?;
        let fields = object_fields(record)?;
        require_kind(fields, AUDIT_KIND)?;
        Ok(Self {
            id,
            tenant_id: string_field(fields, "tenant_id")?,
            operation: GovernedOperation::parse(&string_field(fields, "operation")?)
                .ok_or(MemoryDecodeError::Field { field: "operation" })?,
            subject_id: string_field(fields, "subject_id")?,
            content_digest: optional_string_field(fields, "content_digest")?,
            purpose: string_field(fields, "purpose")?,
            treatment: string_field(fields, "treatment")?,
            policy_id: string_field(fields, "policy_id")?,
            policy_version: string_field(fields, "policy_version")?,
            decision: AuditDecision::parse(&string_field(fields, "decision")?)
                .ok_or(MemoryDecodeError::Field { field: "decision" })?,
            reason_codes: string_array_field(fields, "reason_codes")?,
            review_state: ReviewState::parse(&string_field(fields, "review_state")?).ok_or(
                MemoryDecodeError::Field {
                    field: "review_state",
                },
            )?,
            actor_id: optional_string_field(fields, "actor_id")?,
            occurred_at_ms: integer_field(fields, "occurred_at_ms")?,
            previous_hash: optional_string_field(fields, "previous_hash")?,
            hash: string_field(fields, "hash")?,
        })
    }
}

impl FeedbackEntry {
    /// Encodes this feedback as a canonical Hyphae record.
    pub(crate) fn to_record(&self) -> Record {
        let fields = BTreeMap::from([
            ("kind".to_owned(), Value::String(FEEDBACK_KIND.to_owned())),
            (
                "tenant_id".to_owned(),
                Value::String(self.tenant_id.clone()),
            ),
            (
                "audit_entry_id".to_owned(),
                Value::String(self.audit_entry_id.clone()),
            ),
            (
                "feedback_kind".to_owned(),
                Value::String(self.kind.as_str().to_owned()),
            ),
            (
                "reason_code".to_owned(),
                Value::String(self.reason_code.clone()),
            ),
            (
                "submitted_by".to_owned(),
                optional_string_value(&self.submitted_by),
            ),
            (
                "submitted_at_ms".to_owned(),
                Value::Integer(self.submitted_at_ms),
            ),
        ]);
        Record::new(feedback_key(&self.id), Value::Object(fields))
    }

    /// Decodes a feedback record, rejecting resolution records.
    pub(crate) fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let id = id_from_key(&record.key, FEEDBACK_KEY_PREFIX)?;
        let fields = object_fields(record)?;
        require_kind(fields, FEEDBACK_KIND)?;
        Ok(Self {
            id,
            tenant_id: string_field(fields, "tenant_id")?,
            audit_entry_id: string_field(fields, "audit_entry_id")?,
            kind: FeedbackKind::parse(&string_field(fields, "feedback_kind")?).ok_or(
                MemoryDecodeError::Field {
                    field: "feedback_kind",
                },
            )?,
            reason_code: string_field(fields, "reason_code")?,
            submitted_by: optional_string_field(fields, "submitted_by")?,
            submitted_at_ms: integer_field(fields, "submitted_at_ms")?,
        })
    }
}

impl FeedbackResolution {
    /// Encodes this resolution as a new record in the feedback namespace.
    pub(crate) fn to_record(&self) -> Record {
        let fields = BTreeMap::from([
            (
                "kind".to_owned(),
                Value::String(FEEDBACK_RESOLUTION_KIND.to_owned()),
            ),
            (
                "tenant_id".to_owned(),
                Value::String(self.tenant_id.clone()),
            ),
            (
                "feedback_entry_id".to_owned(),
                Value::String(self.feedback_entry_id.clone()),
            ),
            (
                "disposition".to_owned(),
                Value::String(self.disposition.as_str().to_owned()),
            ),
            (
                "reason_code".to_owned(),
                Value::String(self.reason_code.clone()),
            ),
            (
                "reviewed_by".to_owned(),
                optional_string_value(&self.reviewed_by),
            ),
            (
                "resolved_at_ms".to_owned(),
                Value::Integer(self.resolved_at_ms),
            ),
        ]);
        Record::new(feedback_key(&self.id), Value::Object(fields))
    }

    /// Decodes a feedback resolution record, rejecting feedback records.
    pub(crate) fn from_record(record: &Record) -> Result<Self, MemoryDecodeError> {
        let id = id_from_key(&record.key, FEEDBACK_KEY_PREFIX)?;
        let fields = object_fields(record)?;
        require_kind(fields, FEEDBACK_RESOLUTION_KIND)?;
        Ok(Self {
            id,
            tenant_id: string_field(fields, "tenant_id")?,
            feedback_entry_id: string_field(fields, "feedback_entry_id")?,
            disposition: ReviewDisposition::parse(&string_field(fields, "disposition")?).ok_or(
                MemoryDecodeError::Field {
                    field: "disposition",
                },
            )?,
            reason_code: string_field(fields, "reason_code")?,
            reviewed_by: optional_string_field(fields, "reviewed_by")?,
            resolved_at_ms: integer_field(fields, "resolved_at_ms")?,
        })
    }
}

/// Verifies entries supplied in durable-key order as one tenant chain.
///
/// An entry is reported once if its tenant differs, its previous hash does not
/// match the preceding supplied entry, or its stored hash is not canonical.
pub fn verify_audit_chain(tenant_id: &str, entries: &[EthicsAuditEntry]) -> AuditChainReport {
    let mut expected_previous_hash: Option<&str> = None;
    let mut broken_entry_ids = Vec::new();

    for entry in entries {
        let valid = entry.tenant_id == tenant_id
            && entry.previous_hash.as_deref() == expected_previous_hash
            && entry.hash == entry.compute_hash();
        if !valid {
            broken_entry_ids.push(entry.id.clone());
        }
        expected_previous_hash = Some(&entry.hash);
    }

    AuditChainReport {
        tenant_id: tenant_id.to_owned(),
        total: u64::try_from(entries.len()).unwrap_or(u64::MAX),
        valid: broken_entry_ids.is_empty(),
        broken_entry_ids,
    }
}

/// Durable key for an audit entry.
pub(crate) fn audit_key(entry_id: &str) -> Vec<u8> {
    format!("{AUDIT_KEY_PREFIX}{entry_id}").into_bytes()
}

/// Prefix for scanning all audit records in UUIDv7 order.
pub(crate) fn audit_prefix() -> Vec<u8> {
    AUDIT_KEY_PREFIX.as_bytes().to_vec()
}

/// Durable key for a feedback entry or feedback resolution.
pub(crate) fn feedback_key(entry_id: &str) -> Vec<u8> {
    format!("{FEEDBACK_KEY_PREFIX}{entry_id}").into_bytes()
}

/// Prefix for scanning feedback and resolution records in UUIDv7 order.
pub(crate) fn feedback_prefix() -> Vec<u8> {
    FEEDBACK_KEY_PREFIX.as_bytes().to_vec()
}

fn hash_text(hasher: &mut blake3::Hasher, name: &str, value: &str) {
    hash_bytes(hasher, name.as_bytes(), value.as_bytes());
}

fn hash_optional_text(hasher: &mut blake3::Hasher, name: &str, value: Option<&str>) {
    match value {
        Some(value) => {
            hash_bytes(hasher, name.as_bytes(), &[1]);
            hash_text(hasher, name, value);
        }
        None => hash_bytes(hasher, name.as_bytes(), &[0]),
    }
}

fn hash_bytes(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn optional_string_value(value: &Option<String>) -> Value {
    value.clone().map_or(Value::Null, Value::String)
}

fn string_array_value(values: &[String]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn object_fields(record: &Record) -> Result<&BTreeMap<String, Value>, MemoryDecodeError> {
    match &record.value {
        Value::Object(fields) => Ok(fields),
        _ => Err(MemoryDecodeError::Field { field: "(root)" }),
    }
}

fn require_kind(fields: &BTreeMap<String, Value>, expected: &str) -> Result<(), MemoryDecodeError> {
    if string_field(fields, "kind")? == expected {
        Ok(())
    } else {
        Err(MemoryDecodeError::Field { field: "kind" })
    }
}

fn id_from_key(key: &[u8], prefix: &str) -> Result<String, MemoryDecodeError> {
    let key = std::str::from_utf8(key).map_err(|_| MemoryDecodeError::Key)?;
    let id = key.strip_prefix(prefix).ok_or(MemoryDecodeError::Key)?;
    if id.is_empty() || id.contains('/') {
        return Err(MemoryDecodeError::Key);
    }
    Ok(id.to_owned())
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

fn string_array_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<String>, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                _ => Err(MemoryDecodeError::Field { field }),
            })
            .collect(),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

fn integer_field(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<i64, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => Err(MemoryDecodeError::Field { field }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST_ID: &str = "0195f0a2-1111-7000-8000-000000000001";
    const SECOND_ID: &str = "0195f0a2-2222-7000-8000-000000000001";

    fn audit_entry(id: &str, previous_hash: Option<String>) -> EthicsAuditEntry {
        let mut entry = EthicsAuditEntry {
            id: id.to_owned(),
            tenant_id: "tenant-a".to_owned(),
            operation: GovernedOperation::Disclose,
            subject_id: "memory-42".to_owned(),
            content_digest: Some(blake3::hash(b"not stored").to_hex().to_string()),
            purpose: "assistant_response".to_owned(),
            treatment: "restricted".to_owned(),
            policy_id: "baseline".to_owned(),
            policy_version: "2.0.0".to_owned(),
            decision: AuditDecision::Redact,
            reason_codes: vec!["pii.email".to_owned(), "scope.external".to_owned()],
            review_state: ReviewState::Unreviewed,
            actor_id: Some("agent-1".to_owned()),
            occurred_at_ms: 1_770_000_000_000,
            previous_hash,
            hash: String::new(),
        };
        entry.hash = entry.compute_hash();
        entry
    }

    fn feedback() -> FeedbackEntry {
        FeedbackEntry {
            id: SECOND_ID.to_owned(),
            tenant_id: "tenant-a".to_owned(),
            audit_entry_id: FIRST_ID.to_owned(),
            kind: FeedbackKind::FalsePositive,
            reason_code: "legitimate_context".to_owned(),
            submitted_by: Some("operator-1".to_owned()),
            submitted_at_ms: 1_770_000_001_000,
        }
    }

    fn assert_hash_changes(
        entry: &EthicsAuditEntry,
        expected: &str,
        mutate: impl FnOnce(&mut EthicsAuditEntry),
    ) {
        let mut changed = entry.clone();
        mutate(&mut changed);
        assert_ne!(changed.compute_hash(), expected);
    }

    #[test]
    fn audit_codec_round_trips_all_fields_without_raw_content() {
        let entry = audit_entry(FIRST_ID, None);
        let record = entry.to_record();
        assert_eq!(
            EthicsAuditEntry::from_record(&record).expect("decode"),
            entry
        );
        assert_eq!(record.key, audit_key(FIRST_ID));

        let Value::Object(fields) = record.value else {
            panic!("audit record must be an object");
        };
        assert!(!fields.contains_key("content"));
        assert!(!fields.contains_key("raw_content"));
    }

    #[test]
    fn audit_codec_round_trips_absent_optional_fields() {
        let mut entry = audit_entry(FIRST_ID, None);
        entry.content_digest = None;
        entry.actor_id = None;
        entry.hash = entry.compute_hash();
        assert_eq!(
            EthicsAuditEntry::from_record(&entry.to_record()).expect("decode"),
            entry
        );
    }

    #[test]
    fn feedback_and_resolution_codecs_are_distinct_and_append_only() {
        let feedback = feedback();
        let resolution = FeedbackResolution {
            id: "0195f0a2-3333-7000-8000-000000000001".to_owned(),
            tenant_id: feedback.tenant_id.clone(),
            feedback_entry_id: feedback.id.clone(),
            disposition: ReviewDisposition::Overturned,
            reason_code: "context_verified".to_owned(),
            reviewed_by: None,
            resolved_at_ms: 1_770_000_002_000,
        };

        let feedback_record = feedback.to_record();
        let resolution_record = resolution.to_record();
        assert_eq!(
            FeedbackEntry::from_record(&feedback_record).expect("feedback"),
            feedback
        );
        assert_eq!(
            FeedbackResolution::from_record(&resolution_record).expect("resolution"),
            resolution
        );
        assert_ne!(feedback_record.key, resolution_record.key);
        assert!(FeedbackEntry::from_record(&resolution_record).is_err());
        assert!(FeedbackResolution::from_record(&feedback_record).is_err());
    }

    #[test]
    fn hash_is_deterministic_and_covers_every_stable_field() {
        let entry = audit_entry(FIRST_ID, None);
        let expected = entry.compute_hash();
        assert_eq!(expected, entry.compute_hash());

        assert_hash_changes(&entry, &expected, |value| value.id.push('x'));
        assert_hash_changes(&entry, &expected, |value| value.tenant_id.push('x'));
        assert_hash_changes(&entry, &expected, |value| {
            value.operation = GovernedOperation::Recall;
        });
        assert_hash_changes(&entry, &expected, |value| value.subject_id.push('x'));
        assert_hash_changes(&entry, &expected, |value| value.content_digest = None);
        assert_hash_changes(&entry, &expected, |value| value.purpose.push('x'));
        assert_hash_changes(&entry, &expected, |value| value.treatment.push('x'));
        assert_hash_changes(&entry, &expected, |value| value.policy_id.push('x'));
        assert_hash_changes(&entry, &expected, |value| value.policy_version.push('x'));
        assert_hash_changes(&entry, &expected, |value| {
            value.decision = AuditDecision::Allow;
        });
        assert_hash_changes(&entry, &expected, |value| {
            value.reason_codes.push("new.reason".to_owned());
        });
        assert_hash_changes(&entry, &expected, |value| {
            value.review_state = ReviewState::Pending;
        });
        assert_hash_changes(&entry, &expected, |value| value.actor_id = None);
        assert_hash_changes(&entry, &expected, |value| value.occurred_at_ms += 1);
        assert_hash_changes(&entry, &expected, |value| {
            value.previous_hash = Some("previous".to_owned());
        });
    }

    #[test]
    fn length_prefixing_prevents_field_boundary_collisions() {
        let mut left = audit_entry(FIRST_ID, None);
        left.subject_id = "ab".to_owned();
        left.purpose = "c".to_owned();
        let mut right = left.clone();
        right.subject_id = "a".to_owned();
        right.purpose = "bc".to_owned();
        assert_ne!(left.compute_hash(), right.compute_hash());
    }

    #[test]
    fn chain_verification_accepts_genesis_and_linked_entries() {
        let first = audit_entry(FIRST_ID, None);
        let second = audit_entry(SECOND_ID, Some(first.hash.clone()));
        assert_eq!(
            verify_audit_chain("tenant-a", &[first, second]),
            AuditChainReport {
                tenant_id: "tenant-a".to_owned(),
                total: 2,
                valid: true,
                broken_entry_ids: Vec::new(),
            }
        );
        assert!(verify_audit_chain("tenant-a", &[]).valid);
    }

    #[test]
    fn chain_verification_reports_content_metadata_tampering() {
        let first = audit_entry(FIRST_ID, None);
        let mut second = audit_entry(SECOND_ID, Some(first.hash.clone()));
        second.policy_version = "tampered".to_owned();
        let report = verify_audit_chain("tenant-a", &[first, second]);
        assert!(!report.valid);
        assert_eq!(report.broken_entry_ids, [SECOND_ID]);
    }

    #[test]
    fn chain_verification_reports_broken_links_and_cross_tenant_entries() {
        let first = audit_entry(FIRST_ID, None);
        let mut second = audit_entry(SECOND_ID, Some("wrong".to_owned()));
        second.hash = second.compute_hash();
        let mut foreign = audit_entry(
            "0195f0a2-3333-7000-8000-000000000001",
            Some(second.hash.clone()),
        );
        foreign.tenant_id = "tenant-b".to_owned();
        foreign.hash = foreign.compute_hash();

        let report = verify_audit_chain("tenant-a", &[first, second, foreign]);
        assert!(!report.valid);
        assert_eq!(
            report.broken_entry_ids,
            [SECOND_ID, "0195f0a2-3333-7000-8000-000000000001"]
        );
    }

    #[test]
    fn codecs_reject_wrong_namespaces_kinds_and_field_types() {
        let entry = audit_entry(FIRST_ID, None);
        let mut wrong_key = entry.to_record();
        wrong_key.key = feedback_key(FIRST_ID);
        assert!(EthicsAuditEntry::from_record(&wrong_key).is_err());

        let mut nested_key = entry.to_record();
        nested_key.key = audit_key("nested/id");
        assert!(EthicsAuditEntry::from_record(&nested_key).is_err());

        let mut wrong_kind = entry.to_record();
        if let Value::Object(fields) = &mut wrong_kind.value {
            fields.insert("kind".to_owned(), Value::String(FEEDBACK_KIND.to_owned()));
        }
        assert!(EthicsAuditEntry::from_record(&wrong_kind).is_err());

        let mut wrong_field = entry.to_record();
        if let Value::Object(fields) = &mut wrong_field.value {
            fields.insert("decision".to_owned(), Value::Integer(1));
        }
        assert!(EthicsAuditEntry::from_record(&wrong_field).is_err());
    }

    #[test]
    fn uuidv7_keys_sort_and_prefixes_cover_their_namespaces() {
        assert!(audit_key(FIRST_ID) < audit_key(SECOND_ID));
        assert!(audit_key(FIRST_ID).starts_with(&audit_prefix()));
        assert!(feedback_key(FIRST_ID) < feedback_key(SECOND_ID));
        assert!(feedback_key(FIRST_ID).starts_with(&feedback_prefix()));
    }
}
