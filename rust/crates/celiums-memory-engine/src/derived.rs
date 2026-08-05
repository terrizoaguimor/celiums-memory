// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable hierarchical derived memories and exact source lineage.

use std::collections::BTreeMap;
use std::fmt;

use hyphae_query::{Record, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::TimeBasis;
use crate::{
    ClaimId, ConversationId, EventId, ProjectId, RecallScope, SessionId, TenantId, TurnId, UserId,
};

const DERIVED_KIND: &str = "derived_memory";
const DERIVED_PREFIX: &str = "__celiums/derived/";
const MAX_TEXT_BYTES: usize = 16_384;

/// Stable deterministic derived-memory ID.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct DerivedId(String);

impl DerivedId {
    /// Returns the canonical UUID string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn parse(value: String) -> Result<Self, DerivedDecodeError> {
        Uuid::parse_str(&value).map_err(|_| DerivedDecodeError::Field {
            field: "derived_id",
        })?;
        Ok(Self(value))
    }
}

impl fmt::Display for DerivedId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Hierarchy level of one derived artifact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DerivedKind {
    /// One turn or singleton event group.
    Episode,
    /// Summary of session episodes.
    SessionSummary,
    /// Summary of session/project summaries.
    ProjectSummary,
    /// Summary over a half-open time period.
    PeriodSummary,
    /// Consolidated semantic claim aggregate.
    ClaimAggregate,
}

impl DerivedKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Episode => "episode",
            Self::SessionSummary => "session_summary",
            Self::ProjectSummary => "project_summary",
            Self::PeriodSummary => "period_summary",
            Self::ClaimAggregate => "claim_aggregate",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "episode" => Some(Self::Episode),
            "session_summary" => Some(Self::SessionSummary),
            "project_summary" => Some(Self::ProjectSummary),
            "period_summary" => Some(Self::PeriodSummary),
            "claim_aggregate" => Some(Self::ClaimAggregate),
            _ => None,
        }
    }
}

/// Lifecycle state of a derived artifact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DerivedStatus {
    /// Eligible for hierarchy and recall projection.
    Active,
    /// A source changed or was forgotten; regeneration is required.
    Stale,
    /// No supporting source remains.
    Withdrawn,
    /// The run that created it was rolled back.
    RolledBack,
}

impl DerivedStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Stale => "stale",
            Self::Withdrawn => "withdrawn",
            Self::RolledBack => "rolled_back",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "stale" => Some(Self::Stale),
            "withdrawn" => Some(Self::Withdrawn),
            "rolled_back" => Some(Self::RolledBack),
            _ => None,
        }
    }
}

/// Immediate source of a derived artifact.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum DerivedSource {
    /// Immutable source event.
    Event(EventId),
    /// Lower-level derived artifact.
    Derived(DerivedId),
    /// Atomic claim.
    Claim(ClaimId),
}

impl DerivedSource {
    fn kind(&self) -> &'static str {
        match self {
            Self::Event(_) => "event",
            Self::Derived(_) => "derived",
            Self::Claim(_) => "claim",
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::Event(id) => id.as_str(),
            Self::Derived(id) => id.as_str(),
            Self::Claim(id) => id.as_str(),
        }
    }
}

/// One durable hierarchical artifact with source closure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DerivedMemory {
    /// Stable ID.
    pub id: DerivedId,
    /// Hierarchy level.
    pub kind: DerivedKind,
    /// Owning scope.
    pub scope: RecallScope,
    /// Stable key inside its hierarchy level.
    pub hierarchy_key: String,
    /// Extractive or externally supplied content.
    pub content: String,
    /// Immediate input references in deterministic order.
    pub immediate_sources: Vec<DerivedSource>,
    /// Transitive unique root events.
    pub root_event_ids: Vec<EventId>,
    /// BLAKE3 over immediate sources and root content hashes.
    pub source_digest: String,
    /// Consolidation policy/algorithm revision.
    pub algorithm_version: String,
    /// Artifact state.
    pub status: DerivedStatus,
    /// Original transaction time; retries do not change it.
    pub recorded_at_ms: i64,
    /// Optional period start.
    pub period_from_ms: Option<i64>,
    /// Optional period end.
    pub period_to_ms: Option<i64>,
}

pub(crate) struct NewDerivedMemory {
    pub(crate) kind: DerivedKind,
    pub(crate) scope: RecallScope,
    pub(crate) hierarchy_key: String,
    pub(crate) content: String,
    pub(crate) immediate_sources: Vec<DerivedSource>,
    pub(crate) root_event_ids: Vec<EventId>,
    pub(crate) source_digest: String,
    pub(crate) algorithm_version: String,
    pub(crate) recorded_at_ms: i64,
    pub(crate) period: Option<(i64, i64)>,
}

impl DerivedMemory {
    pub(crate) fn build(new: NewDerivedMemory) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"celiums-memory/derived-id/v1");
        hash_scope(&mut hasher, &new.scope);
        hash_field(&mut hasher, b"kind", new.kind.as_str().as_bytes());
        hash_field(&mut hasher, b"hierarchy_key", new.hierarchy_key.as_bytes());
        hash_field(&mut hasher, b"source_digest", new.source_digest.as_bytes());
        hash_field(
            &mut hasher,
            b"algorithm_version",
            new.algorithm_version.as_bytes(),
        );
        if let Some((from, to)) = new.period {
            hash_field(&mut hasher, b"period_from_ms", &from.to_le_bytes());
            hash_field(&mut hasher, b"period_to_ms", &to.to_le_bytes());
        }
        Self {
            id: DerivedId(uuid_from_hash(hasher.finalize()).to_string()),
            kind: new.kind,
            scope: new.scope,
            hierarchy_key: new.hierarchy_key,
            content: new.content,
            immediate_sources: new.immediate_sources,
            root_event_ids: new.root_event_ids,
            source_digest: new.source_digest,
            algorithm_version: new.algorithm_version,
            status: DerivedStatus::Active,
            recorded_at_ms: new.recorded_at_ms,
            period_from_ms: new.period.map(|value| value.0),
            period_to_ms: new.period.map(|value| value.1),
        }
    }

    pub(crate) fn key(id: &DerivedId) -> Vec<u8> {
        format!("{DERIVED_PREFIX}{id}").into_bytes()
    }

    pub(crate) fn prefix() -> &'static [u8] {
        DERIVED_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(DERIVED_KIND)),
            ("derived_id".to_owned(), string(self.id.as_str())),
            ("derived_kind".to_owned(), string(self.kind.as_str())),
            ("hierarchy_key".to_owned(), string(&self.hierarchy_key)),
            ("content".to_owned(), string(&self.content)),
            (
                "immediate_sources".to_owned(),
                source_array(&self.immediate_sources),
            ),
            (
                "root_event_ids".to_owned(),
                Value::Array(
                    self.root_event_ids
                        .iter()
                        .map(|id| string(id.as_str()))
                        .collect(),
                ),
            ),
            ("source_digest".to_owned(), string(&self.source_digest)),
            (
                "algorithm_version".to_owned(),
                string(&self.algorithm_version),
            ),
            ("status".to_owned(), string(self.status.as_str())),
            (
                "recorded_at_ms".to_owned(),
                Value::Integer(self.recorded_at_ms),
            ),
            (
                "period_from_ms".to_owned(),
                nullable_integer(self.period_from_ms),
            ),
            (
                "period_to_ms".to_owned(),
                nullable_integer(self.period_to_ms),
            ),
        ]));
        Record::new(Self::key(&self.id), Value::Object(fields))
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, DerivedDecodeError> {
        if !record.key.starts_with(Self::prefix()) {
            return Err(DerivedDecodeError::Key);
        }
        let Value::Object(fields) = &record.value else {
            return field_error("(root)");
        };
        if text(fields, "kind")? != DERIVED_KIND {
            return field_error("kind");
        }
        Ok(Self {
            id: DerivedId::parse(text(fields, "derived_id")?)?,
            kind: DerivedKind::parse(&text(fields, "derived_kind")?).ok_or(
                DerivedDecodeError::Field {
                    field: "derived_kind",
                },
            )?,
            scope: scope_from_fields(fields)?,
            hierarchy_key: text(fields, "hierarchy_key")?,
            content: text(fields, "content")?,
            immediate_sources: sources(fields, "immediate_sources")?,
            root_event_ids: strings(fields, "root_event_ids")?
                .into_iter()
                .map(|value| {
                    EventId::parse(value).map_err(|_| DerivedDecodeError::Field {
                        field: "root_event_ids",
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            source_digest: text(fields, "source_digest")?,
            algorithm_version: text(fields, "algorithm_version")?,
            status: DerivedStatus::parse(&text(fields, "status")?)
                .ok_or(DerivedDecodeError::Field { field: "status" })?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
            period_from_ms: optional_integer(fields, "period_from_ms")?,
            period_to_ms: optional_integer(fields, "period_to_ms")?,
        })
    }
}

/// Request to consolidate all visible events in one explicit turn.
#[derive(Clone, Debug)]
pub struct ConsolidateTurnRequest {
    /// Exact turn scope.
    pub scope: RecallScope,
    /// Required turn ID.
    pub turn_id: TurnId,
    /// Deterministic algorithm/policy version.
    pub algorithm_version: String,
    /// Transaction time used only on first creation.
    pub recorded_at_ms: i64,
}

/// Explicit half-open period with timezone provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeriodWindow {
    /// Inclusive period start.
    pub from_ms: i64,
    /// Exclusive period end.
    pub to_ms: i64,
    /// Timezone/reference basis.
    pub basis: TimeBasis,
}

/// Request to summarize lower-level derived artifacts.
#[derive(Clone, Debug)]
pub struct ConsolidateSummaryRequest {
    /// Authorization and hierarchy boundary.
    pub scope: RecallScope,
    /// Session, project or period summary kind.
    pub kind: DerivedKind,
    /// Stable session/project/period key.
    pub hierarchy_key: String,
    /// Algorithm/policy version.
    pub algorithm_version: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
    /// Required for period summaries, forbidden otherwise.
    pub period: Option<PeriodWindow>,
}

/// Invalid derived-memory request.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum InvalidDerived {
    /// Required string is invalid.
    #[error("derived {field} must be 1..=16384 bytes, trimmed, and contain no controls")]
    Text {
        /// Invalid component.
        field: &'static str,
    },
    /// Period bounds are invalid.
    #[error("derived period start must be earlier than end")]
    Period,
}

/// Failure decoding durable derived state.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum DerivedDecodeError {
    /// Record key is outside the derived namespace.
    #[error("record key is outside the derived namespace")]
    Key,
    /// Field is missing, mistyped, or invalid.
    #[error("derived field `{field}` is missing, mistyped, or invalid")]
    Field {
        /// Invalid field.
        field: &'static str,
    },
}

pub(crate) fn validate_text(value: &str, field: &'static str) -> Result<(), InvalidDerived> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(InvalidDerived::Text { field });
    }
    Ok(())
}

pub(crate) fn source_digest(
    sources: &[DerivedSource],
    root_hashes: &[(EventId, String)],
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/derived-source-digest/v1");
    for source in sources {
        hash_field(&mut hasher, b"source_kind", source.kind().as_bytes());
        hash_field(&mut hasher, b"source_id", source.id().as_bytes());
    }
    for (event_id, hash) in root_hashes {
        hash_field(&mut hasher, b"root_event_id", event_id.as_str().as_bytes());
        hash_field(&mut hasher, b"root_content_hash", hash.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn source_array(sources: &[DerivedSource]) -> Value {
    Value::Array(
        sources
            .iter()
            .map(|source| {
                Value::Object(BTreeMap::from([
                    ("kind".to_owned(), string(source.kind())),
                    ("id".to_owned(), string(source.id())),
                ]))
            })
            .collect(),
    )
}

fn sources(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<DerivedSource>, DerivedDecodeError> {
    let Some(Value::Array(values)) = fields.get(field) else {
        return field_error(field);
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(source) = value else {
                return field_error(field);
            };
            let id = text(source, "id")?;
            match text(source, "kind")?.as_str() {
                "event" => EventId::parse(id)
                    .map(DerivedSource::Event)
                    .map_err(|_| DerivedDecodeError::Field { field }),
                "derived" => DerivedId::parse(id).map(DerivedSource::Derived),
                "claim" => ClaimId::parse(id)
                    .map(DerivedSource::Claim)
                    .map_err(|_| DerivedDecodeError::Field { field }),
                _ => field_error(field),
            }
        })
        .collect()
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

fn scope_from_fields(fields: &BTreeMap<String, Value>) -> Result<RecallScope, DerivedDecodeError> {
    Ok(RecallScope {
        tenant_id: TenantId::new(text(fields, "tenant_id")?)
            .map_err(|_| DerivedDecodeError::Field { field: "tenant_id" })?,
        user_id: UserId::new(text(fields, "user_id")?)
            .map_err(|_| DerivedDecodeError::Field { field: "user_id" })?,
        project_id: optional_identity(fields, "project_id", ProjectId::new)?,
        conversation_id: optional_identity(fields, "conversation_id", ConversationId::new)?,
        session_id: optional_identity(fields, "session_id", SessionId::new)?,
    })
}

fn optional_identity<T>(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
    constructor: impl FnOnce(String) -> Result<T, crate::InvalidIdentity>,
) -> Result<Option<T>, DerivedDecodeError> {
    optional_text(fields, field)?
        .map(|value| constructor(value).map_err(|_| DerivedDecodeError::Field { field }))
        .transpose()
}

fn insert_optional(fields: &mut BTreeMap<String, Value>, field: &str, value: Option<&str>) {
    fields.insert(field.to_owned(), value.map_or(Value::Null, string));
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn nullable_integer(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Value::Integer)
}

fn text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<String, DerivedDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => field_error(field),
    }
}

fn optional_text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<String>, DerivedDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => field_error(field),
    }
}

fn integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<i64, DerivedDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => field_error(field),
    }
}

fn optional_integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<i64>, DerivedDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => field_error(field),
    }
}

fn strings(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<String>, DerivedDecodeError> {
    let Some(Value::Array(values)) = fields.get(field) else {
        return field_error(field);
    };
    values
        .iter()
        .map(|value| match value {
            Value::String(value) => Ok(value.clone()),
            _ => field_error(field),
        })
        .collect()
}

fn field_error<T>(field: &'static str) -> Result<T, DerivedDecodeError> {
    Err(DerivedDecodeError::Field { field })
}

fn hash_scope(hasher: &mut blake3::Hasher, scope: &RecallScope) {
    hash_field(hasher, b"tenant_id", scope.tenant_id.as_str().as_bytes());
    hash_field(hasher, b"user_id", scope.user_id.as_str().as_bytes());
    hash_optional(
        hasher,
        b"project_id",
        scope.project_id.as_ref().map(ProjectId::as_str),
    );
    hash_optional(
        hasher,
        b"conversation_id",
        scope.conversation_id.as_ref().map(ConversationId::as_str),
    );
    hash_optional(
        hasher,
        b"session_id",
        scope.session_id.as_ref().map(SessionId::as_str),
    );
}

fn hash_optional(hasher: &mut blake3::Hasher, name: &[u8], value: Option<&str>) {
    match value {
        Some(value) => {
            hash_field(hasher, name, &[1]);
            hash_field(hasher, name, value.as_bytes());
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
