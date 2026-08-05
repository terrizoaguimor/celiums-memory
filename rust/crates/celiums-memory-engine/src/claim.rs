// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable atomic claims and links to immutable source-event evidence.

use std::collections::BTreeMap;
use std::fmt;

use hyphae_query::{Record, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::{ConversationId, EventId, ProjectId, RecallScope, SessionId, TenantId, UserId};

const CLAIM_KIND: &str = "claim";
const CLAIM_PREFIX: &str = "__celiums/claim/";
const EVIDENCE_KIND: &str = "claim_evidence";
const EVIDENCE_PREFIX: &str = "__celiums/claim_evidence/";
const CLAIM_ID_DOMAIN: &[u8] = b"celiums-memory/claim-id/v1";
const MAX_CLAIM_PART_BYTES: usize = 4_096;
const NANOS: f64 = 1_000_000_000.0;

/// Stable identifier of one atomic claim.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ClaimId(String);

impl ClaimId {
    pub(crate) fn derive(request: &CreateClaimRequest) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(CLAIM_ID_DOMAIN);
        hash_scope(&mut hasher, &request.scope);
        hash_field(&mut hasher, b"subject", request.subject.as_bytes());
        hash_field(&mut hasher, b"predicate", request.predicate.as_bytes());
        hash_field(&mut hasher, b"value", request.value.as_bytes());
        hash_optional_i64(&mut hasher, b"valid_from_ms", request.valid_from_ms);
        hash_optional_i64(&mut hasher, b"valid_to_ms", request.valid_to_ms);
        for evidence in &request.evidence {
            hash_field(
                &mut hasher,
                b"event_id",
                evidence.event_id.as_str().as_bytes(),
            );
            hash_field(
                &mut hasher,
                b"relation",
                evidence.relation.as_str().as_bytes(),
            );
            hash_optional_text(&mut hasher, b"excerpt", evidence.excerpt.as_deref());
        }
        Self(uuid_from_hash(hasher.finalize()).to_string())
    }

    /// Returns the canonical UUID string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parse(value: String) -> Result<Self, ClaimDecodeError> {
        Uuid::parse_str(&value).map_err(|_| ClaimDecodeError::Field { field: "claim_id" })?;
        Ok(Self(value))
    }
}

impl fmt::Display for ClaimId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// How one raw episode relates to a claim.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimEvidenceRelation {
    /// The event supports the claim.
    Supports,
    /// The event refutes the claim.
    Refutes,
    /// The event narrows or qualifies the claim.
    Qualifies,
}

impl ClaimEvidenceRelation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Supports => "supports",
            Self::Refutes => "refutes",
            Self::Qualifies => "qualifies",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "supports" => Some(Self::Supports),
            "refutes" => Some(Self::Refutes),
            "qualifies" => Some(Self::Qualifies),
            _ => None,
        }
    }
}

/// Evidence supplied while creating a claim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimEvidenceInput {
    /// Durable source-event ID.
    pub event_id: EventId,
    /// Evidentiary relation.
    pub relation: ClaimEvidenceRelation,
    /// Optional exact excerpt from the raw event.
    pub excerpt: Option<String>,
}

/// Request to derive one atomic claim from raw evidence.
#[derive(Clone, Debug)]
pub struct CreateClaimRequest {
    /// Authorized owner and query boundary.
    pub scope: RecallScope,
    /// Canonical subject label.
    pub subject: String,
    /// Canonical property/relation label.
    pub predicate: String,
    /// Claimed value.
    pub value: String,
    /// Confidence in `[0, 1]`.
    pub confidence: f64,
    /// Inclusive valid-time start.
    pub valid_from_ms: Option<i64>,
    /// Exclusive valid-time end.
    pub valid_to_ms: Option<i64>,
    /// Transaction time when the claim became known.
    pub recorded_at_ms: i64,
    /// At least one visible source event.
    pub evidence: Vec<ClaimEvidenceInput>,
}

impl CreateClaimRequest {
    pub(crate) fn validate(&self) -> Result<(), InvalidClaim> {
        validate_part(&self.subject, "subject")?;
        validate_part(&self.predicate, "predicate")?;
        validate_part(&self.value, "value")?;
        if !self.confidence.is_finite() || !(0.0..=1.0).contains(&self.confidence) {
            return Err(InvalidClaim::Confidence);
        }
        if self.evidence.is_empty() {
            return Err(InvalidClaim::Evidence);
        }
        if matches!((self.valid_from_ms, self.valid_to_ms), (Some(from), Some(to)) if from >= to) {
            return Err(InvalidClaim::Validity);
        }
        Ok(())
    }
}

/// Invalid claim request.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum InvalidClaim {
    /// Subject, predicate, or value is empty, oversized, padded, or contains controls.
    #[error("claim {field} must be 1..=4096 bytes, trimmed, and contain no control characters")]
    Text {
        /// Invalid component.
        field: &'static str,
    },
    /// Confidence lies outside the public scalar domain.
    #[error("claim confidence must be finite and within 0..=1")]
    Confidence,
    /// No source evidence was supplied.
    #[error("claim requires at least one source event")]
    Evidence,
    /// The validity interval is empty or inverted.
    #[error("claim valid_from_ms must be earlier than valid_to_ms")]
    Validity,
}

/// One durable atomic knowledge claim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claim {
    /// Stable deterministic ID.
    pub id: ClaimId,
    /// Owning authorization scope.
    pub scope: RecallScope,
    /// Canonical subject.
    pub subject: String,
    /// Canonical predicate.
    pub predicate: String,
    /// Claimed value.
    pub value: String,
    /// Confidence stored as deterministic nanos.
    pub confidence_nanos: i64,
    /// Inclusive valid-time start.
    pub valid_from_ms: Option<i64>,
    /// Exclusive valid-time end.
    pub valid_to_ms: Option<i64>,
    /// Transaction time when first recorded.
    pub recorded_at_ms: i64,
    /// Number of attached evidence links.
    pub evidence_count: u64,
}

impl Claim {
    pub(crate) fn from_request(request: &CreateClaimRequest) -> Self {
        Self {
            id: ClaimId::derive(request),
            scope: request.scope.clone(),
            subject: request.subject.clone(),
            predicate: request.predicate.clone(),
            value: request.value.clone(),
            confidence_nanos: scalar_nanos(request.confidence),
            valid_from_ms: request.valid_from_ms,
            valid_to_ms: request.valid_to_ms,
            recorded_at_ms: request.recorded_at_ms,
            evidence_count: request.evidence.len() as u64,
        }
    }

    /// Returns confidence in the public scalar domain.
    pub fn confidence(&self) -> f64 {
        #[allow(clippy::cast_precision_loss)]
        {
            self.confidence_nanos as f64 / NANOS
        }
    }

    pub(crate) fn key(id: &ClaimId) -> Vec<u8> {
        format!("{CLAIM_PREFIX}{}", id.as_str()).into_bytes()
    }

    pub(crate) fn prefix() -> &'static [u8] {
        CLAIM_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(CLAIM_KIND)),
            ("claim_id".to_owned(), string(self.id.as_str())),
            ("subject".to_owned(), string(&self.subject)),
            ("predicate".to_owned(), string(&self.predicate)),
            ("value".to_owned(), string(&self.value)),
            (
                "confidence_nanos".to_owned(),
                Value::Integer(self.confidence_nanos),
            ),
            (
                "valid_from_ms".to_owned(),
                optional_integer(self.valid_from_ms),
            ),
            ("valid_to_ms".to_owned(), optional_integer(self.valid_to_ms)),
            (
                "recorded_at_ms".to_owned(),
                Value::Integer(self.recorded_at_ms),
            ),
            (
                "evidence_count".to_owned(),
                Value::Integer(i64::try_from(self.evidence_count).unwrap_or(i64::MAX)),
            ),
        ]));
        Record::new(Self::key(&self.id), Value::Object(fields))
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, ClaimDecodeError> {
        if !record.key.starts_with(Self::prefix()) {
            return Err(ClaimDecodeError::Key);
        }
        let Value::Object(fields) = &record.value else {
            return field_error("(root)");
        };
        if text(fields, "kind")? != CLAIM_KIND {
            return field_error("kind");
        }
        Ok(Self {
            id: ClaimId::parse(text(fields, "claim_id")?)?,
            scope: scope_from_fields(fields)?,
            subject: text(fields, "subject")?,
            predicate: text(fields, "predicate")?,
            value: text(fields, "value")?,
            confidence_nanos: integer(fields, "confidence_nanos")?,
            valid_from_ms: nullable_integer(fields, "valid_from_ms")?,
            valid_to_ms: nullable_integer(fields, "valid_to_ms")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
            evidence_count: unsigned(fields, "evidence_count")?,
        })
    }
}

/// Durable link from one claim to one immutable episode.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimEvidence {
    /// Derived claim.
    pub claim_id: ClaimId,
    /// Immutable source episode.
    pub event_id: EventId,
    /// Evidentiary relation.
    pub relation: ClaimEvidenceRelation,
    /// Optional exact source excerpt.
    pub excerpt: Option<String>,
    /// Link creation transaction time.
    pub recorded_at_ms: i64,
}

impl ClaimEvidence {
    pub(crate) fn from_input(
        claim_id: ClaimId,
        input: &ClaimEvidenceInput,
        recorded_at_ms: i64,
    ) -> Self {
        Self {
            claim_id,
            event_id: input.event_id.clone(),
            relation: input.relation,
            excerpt: input.excerpt.clone(),
            recorded_at_ms,
        }
    }

    pub(crate) fn prefix(claim_id: &ClaimId) -> Vec<u8> {
        format!("{EVIDENCE_PREFIX}{}/", claim_id.as_str()).into_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let key = format!(
            "{EVIDENCE_PREFIX}{}/{}-{}",
            self.claim_id,
            self.event_id,
            self.relation.as_str()
        )
        .into_bytes();
        Record::new(
            key,
            Value::Object(BTreeMap::from([
                ("kind".to_owned(), string(EVIDENCE_KIND)),
                ("claim_id".to_owned(), string(self.claim_id.as_str())),
                ("event_id".to_owned(), string(self.event_id.as_str())),
                ("relation".to_owned(), string(self.relation.as_str())),
                (
                    "excerpt".to_owned(),
                    self.excerpt.as_deref().map_or(Value::Null, string),
                ),
                (
                    "recorded_at_ms".to_owned(),
                    Value::Integer(self.recorded_at_ms),
                ),
            ])),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, ClaimDecodeError> {
        if !record.key.starts_with(EVIDENCE_PREFIX.as_bytes()) {
            return Err(ClaimDecodeError::Key);
        }
        let Value::Object(fields) = &record.value else {
            return field_error("(root)");
        };
        if text(fields, "kind")? != EVIDENCE_KIND {
            return field_error("kind");
        }
        Ok(Self {
            claim_id: ClaimId::parse(text(fields, "claim_id")?)?,
            event_id: EventId::parse(text(fields, "event_id")?)
                .map_err(|_| ClaimDecodeError::Field { field: "event_id" })?,
            relation: ClaimEvidenceRelation::parse(&text(fields, "relation")?)
                .ok_or(ClaimDecodeError::Field { field: "relation" })?,
            excerpt: nullable_text(fields, "excerpt")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
        })
    }
}

/// Failure decoding claim state.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum ClaimDecodeError {
    /// Record key is outside a claim namespace.
    #[error("record key is outside the claim namespace")]
    Key,
    /// Required field is missing, mistyped, or invalid.
    #[error("claim document field `{field}` is missing, mistyped, or invalid")]
    Field {
        /// Invalid field.
        field: &'static str,
    },
}

fn validate_part(value: &str, field: &'static str) -> Result<(), InvalidClaim> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_CLAIM_PART_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(InvalidClaim::Text { field });
    }
    Ok(())
}

fn scope_fields(scope: &RecallScope) -> BTreeMap<String, Value> {
    let mut fields = BTreeMap::from([
        ("tenant_id".to_owned(), string(scope.tenant_id.as_str())),
        ("user_id".to_owned(), string(scope.user_id.as_str())),
    ]);
    insert_optional(
        &mut fields,
        "project_id",
        scope.project_id.as_ref().map(ProjectId::as_str),
    );
    insert_optional(
        &mut fields,
        "conversation_id",
        scope.conversation_id.as_ref().map(ConversationId::as_str),
    );
    insert_optional(
        &mut fields,
        "session_id",
        scope.session_id.as_ref().map(SessionId::as_str),
    );
    fields
}

fn scope_from_fields(fields: &BTreeMap<String, Value>) -> Result<RecallScope, ClaimDecodeError> {
    Ok(RecallScope {
        tenant_id: TenantId::new(text(fields, "tenant_id")?)
            .map_err(|_| ClaimDecodeError::Field { field: "tenant_id" })?,
        user_id: UserId::new(text(fields, "user_id")?)
            .map_err(|_| ClaimDecodeError::Field { field: "user_id" })?,
        project_id: optional_identity(fields, "project_id", ProjectId::new)?,
        conversation_id: optional_identity(fields, "conversation_id", ConversationId::new)?,
        session_id: optional_identity(fields, "session_id", SessionId::new)?,
    })
}

fn optional_identity<T>(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
    constructor: impl FnOnce(String) -> Result<T, crate::InvalidIdentity>,
) -> Result<Option<T>, ClaimDecodeError> {
    nullable_text(fields, field)?
        .map(|value| constructor(value).map_err(|_| ClaimDecodeError::Field { field }))
        .transpose()
}

fn insert_optional(fields: &mut BTreeMap<String, Value>, field: &str, value: Option<&str>) {
    fields.insert(field.to_owned(), value.map_or(Value::Null, string));
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn optional_integer(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Value::Integer)
}

fn text(fields: &BTreeMap<String, Value>, field: &'static str) -> Result<String, ClaimDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => field_error(field),
    }
}

fn nullable_text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<String>, ClaimDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => field_error(field),
    }
}

fn integer(fields: &BTreeMap<String, Value>, field: &'static str) -> Result<i64, ClaimDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => field_error(field),
    }
}

fn nullable_integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<i64>, ClaimDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => field_error(field),
    }
}

fn unsigned(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<u64, ClaimDecodeError> {
    integer(fields, field)?
        .try_into()
        .map_err(|_| ClaimDecodeError::Field { field })
}

fn field_error<T>(field: &'static str) -> Result<T, ClaimDecodeError> {
    Err(ClaimDecodeError::Field { field })
}

fn scalar_nanos(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value * NANOS).round() as i64
    }
}

fn hash_scope(hasher: &mut blake3::Hasher, scope: &RecallScope) {
    hash_field(hasher, b"tenant_id", scope.tenant_id.as_str().as_bytes());
    hash_field(hasher, b"user_id", scope.user_id.as_str().as_bytes());
    hash_optional_text(
        hasher,
        b"project_id",
        scope.project_id.as_ref().map(ProjectId::as_str),
    );
    hash_optional_text(
        hasher,
        b"conversation_id",
        scope.conversation_id.as_ref().map(ConversationId::as_str),
    );
    hash_optional_text(
        hasher,
        b"session_id",
        scope.session_id.as_ref().map(SessionId::as_str),
    );
}

fn hash_optional_text(hasher: &mut blake3::Hasher, name: &[u8], value: Option<&str>) {
    match value {
        Some(value) => {
            hash_field(hasher, name, &[1]);
            hash_field(hasher, name, value.as_bytes());
        }
        None => hash_field(hasher, name, &[0]),
    }
}

fn hash_optional_i64(hasher: &mut blake3::Hasher, name: &[u8], value: Option<i64>) {
    match value {
        Some(value) => {
            hash_field(hasher, name, &[1]);
            hash_field(hasher, name, &value.to_le_bytes());
        }
        None => hash_field(hasher, name, &[0]),
    }
}

fn hash_field(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn uuid_from_hash(hash: blake3::Hash) -> Uuid {
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&hash.as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}
