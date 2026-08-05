// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable canonical entities, aliases, ontology and lineage.

use std::collections::BTreeMap;
use std::fmt;

use hyphae_query::{Record, Value};
use thiserror::Error;
use uuid::Uuid;

use crate::{EventId, ProjectId, RecallScope, SessionId, TenantId, UserId};

const ENTITY_KIND: &str = "canonical_entity";
const ENTITY_PREFIX: &str = "__celiums/graph/entity/";
const ALIAS_KIND: &str = "entity_alias";
const ALIAS_PREFIX: &str = "__celiums/graph/alias/";
const LINEAGE_KIND: &str = "entity_lineage";
const LINEAGE_PREFIX: &str = "__celiums/graph/lineage/";
const ENTITY_TYPE_KIND: &str = "entity_type";
const ENTITY_TYPE_PREFIX: &str = "__celiums/graph/ontology/entity_type/";
const MAX_TEXT_BYTES: usize = 4_096;

macro_rules! graph_id {
    ($name:ident, $field:literal) => {
        #[doc = concat!("Stable ", $field, ".")]
        #[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            /// Returns the canonical UUID string.
            pub fn as_str(&self) -> &str {
                &self.0
            }

            fn parse(value: String) -> Result<Self, GraphDecodeError> {
                Uuid::parse_str(&value).map_err(|_| GraphDecodeError::Field { field: $field })?;
                Ok(Self(value))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

graph_id!(EntityId, "entity_id");

/// Source evidence attached to graph facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphEvidenceInput {
    /// Immutable source event.
    pub event_id: EventId,
    /// Optional exact excerpt.
    pub excerpt: Option<String>,
}

/// Request to create one canonical entity.
#[derive(Clone, Debug)]
pub struct CreateEntityRequest {
    /// Authorization and visibility boundary.
    pub scope: RecallScope,
    /// Ontology entity type ID.
    pub entity_type: String,
    /// Preferred display label.
    pub canonical_label: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
    /// Source evidence.
    pub evidence: Vec<GraphEvidenceInput>,
}

/// One canonical entity with stable identity independent of aliases.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CanonicalEntity {
    /// Stable entity identity.
    pub id: EntityId,
    /// Owning scope.
    pub scope: RecallScope,
    /// Ontology entity type.
    pub entity_type: String,
    /// Preferred display label.
    pub canonical_label: String,
    /// Creation transaction time.
    pub recorded_at_ms: i64,
    /// Number of source evidence links.
    pub evidence_count: u64,
}

impl CanonicalEntity {
    pub(crate) fn from_request(request: &CreateEntityRequest) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"celiums-memory/entity-id/v1");
        hash_scope(&mut hasher, &request.scope);
        hash_field(&mut hasher, b"entity_type", request.entity_type.as_bytes());
        hash_field(
            &mut hasher,
            b"canonical_label",
            normalize_label(&request.canonical_label).as_bytes(),
        );
        Self {
            id: EntityId(uuid_from_hash(hasher.finalize()).to_string()),
            scope: request.scope.clone(),
            entity_type: request.entity_type.clone(),
            canonical_label: request.canonical_label.clone(),
            recorded_at_ms: request.recorded_at_ms,
            evidence_count: request.evidence.len() as u64,
        }
    }

    pub(crate) fn key(id: &EntityId) -> Vec<u8> {
        format!("{ENTITY_PREFIX}{id}").into_bytes()
    }

    pub(crate) fn prefix() -> &'static [u8] {
        ENTITY_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(ENTITY_KIND)),
            ("entity_id".to_owned(), string(self.id.as_str())),
            ("entity_type".to_owned(), string(&self.entity_type)),
            ("canonical_label".to_owned(), string(&self.canonical_label)),
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

    pub(crate) fn from_record(record: &Record) -> Result<Self, GraphDecodeError> {
        let fields = object(record, Self::prefix(), ENTITY_KIND)?;
        Ok(Self {
            id: EntityId::parse(text(fields, "entity_id")?)?,
            scope: scope_from_fields(fields)?,
            entity_type: text(fields, "entity_type")?,
            canonical_label: text(fields, "canonical_label")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
            evidence_count: unsigned(fields, "evidence_count")?,
        })
    }
}

/// Request to define a configurable entity type.
#[derive(Clone, Debug)]
pub struct DefineEntityTypeRequest {
    /// Owning scope.
    pub scope: RecallScope,
    /// Stable type ID.
    pub type_id: String,
    /// Immutable ontology version label.
    pub ontology_version: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

/// Durable ontology entity type definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntityTypeDefinition {
    /// Owning scope.
    pub scope: RecallScope,
    /// Stable type ID.
    pub type_id: String,
    /// Version under which graph records are interpreted.
    pub ontology_version: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

impl EntityTypeDefinition {
    pub(crate) fn from_request(request: DefineEntityTypeRequest) -> Self {
        Self {
            scope: request.scope,
            type_id: request.type_id,
            ontology_version: request.ontology_version,
            recorded_at_ms: request.recorded_at_ms,
        }
    }

    pub(crate) fn prefix() -> &'static [u8] {
        ENTITY_TYPE_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut hasher = blake3::Hasher::new();
        hash_scope(&mut hasher, &self.scope);
        hash_field(&mut hasher, b"type_id", self.type_id.as_bytes());
        hash_field(
            &mut hasher,
            b"ontology_version",
            self.ontology_version.as_bytes(),
        );
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(ENTITY_TYPE_KIND)),
            ("type_id".to_owned(), string(&self.type_id)),
            (
                "ontology_version".to_owned(),
                string(&self.ontology_version),
            ),
            (
                "recorded_at_ms".to_owned(),
                Value::Integer(self.recorded_at_ms),
            ),
        ]));
        Record::new(
            format!("{ENTITY_TYPE_PREFIX}{}", hasher.finalize().to_hex()).into_bytes(),
            Value::Object(fields),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, GraphDecodeError> {
        let fields = object(record, Self::prefix(), ENTITY_TYPE_KIND)?;
        Ok(Self {
            scope: scope_from_fields(fields)?,
            type_id: text(fields, "type_id")?,
            ontology_version: text(fields, "ontology_version")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
        })
    }
}

/// Request to add one temporal alias.
#[derive(Clone, Debug)]
pub struct EntityAliasRequest {
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Alias target.
    pub entity_id: EntityId,
    /// Display alias.
    pub alias: String,
    /// Inclusive valid-time start.
    pub valid_from_ms: Option<i64>,
    /// Exclusive valid-time end.
    pub valid_to_ms: Option<i64>,
    /// Transaction time.
    pub recorded_at_ms: i64,
    /// Optional evidence.
    pub evidence: Vec<GraphEvidenceInput>,
}

/// One temporal entity alias.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntityAlias {
    /// Target entity.
    pub entity_id: EntityId,
    /// Original display alias.
    pub alias: String,
    /// Normalized exact-match label.
    pub normalized_alias: String,
    /// Inclusive validity start.
    pub valid_from_ms: Option<i64>,
    /// Exclusive validity end.
    pub valid_to_ms: Option<i64>,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

impl EntityAlias {
    pub(crate) fn from_request(request: &EntityAliasRequest) -> Self {
        Self {
            entity_id: request.entity_id.clone(),
            alias: request.alias.clone(),
            normalized_alias: normalize_label(&request.alias),
            valid_from_ms: request.valid_from_ms,
            valid_to_ms: request.valid_to_ms,
            recorded_at_ms: request.recorded_at_ms,
        }
    }

    pub(crate) fn prefix() -> &'static [u8] {
        ALIAS_PREFIX.as_bytes()
    }

    pub(crate) fn valid_at(&self, valid_at_ms: i64, known_at_ms: i64) -> bool {
        self.recorded_at_ms <= known_at_ms
            && self.valid_from_ms.is_none_or(|from| from <= valid_at_ms)
            && self.valid_to_ms.is_none_or(|to| valid_at_ms < to)
    }

    pub(crate) fn to_record(&self, scope: &RecallScope, entity_type: &str) -> Record {
        let mut hasher = blake3::Hasher::new();
        hash_scope(&mut hasher, scope);
        hash_field(&mut hasher, b"entity_type", entity_type.as_bytes());
        hash_field(
            &mut hasher,
            b"normalized_alias",
            self.normalized_alias.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"entity_id",
            self.entity_id.as_str().as_bytes(),
        );
        let mut fields = scope_fields(scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(ALIAS_KIND)),
            ("entity_id".to_owned(), string(self.entity_id.as_str())),
            ("entity_type".to_owned(), string(entity_type)),
            ("alias".to_owned(), string(&self.alias)),
            (
                "normalized_alias".to_owned(),
                string(&self.normalized_alias),
            ),
            (
                "valid_from_ms".to_owned(),
                nullable_integer(self.valid_from_ms),
            ),
            ("valid_to_ms".to_owned(), nullable_integer(self.valid_to_ms)),
            (
                "recorded_at_ms".to_owned(),
                Value::Integer(self.recorded_at_ms),
            ),
        ]));
        Record::new(
            format!("{ALIAS_PREFIX}{}", hasher.finalize().to_hex()).into_bytes(),
            Value::Object(fields),
        )
    }

    pub(crate) fn from_record(
        record: &Record,
    ) -> Result<(Self, RecallScope, String), GraphDecodeError> {
        let fields = object(record, Self::prefix(), ALIAS_KIND)?;
        Ok((
            Self {
                entity_id: EntityId::parse(text(fields, "entity_id")?)?,
                alias: text(fields, "alias")?,
                normalized_alias: text(fields, "normalized_alias")?,
                valid_from_ms: optional_integer(fields, "valid_from_ms")?,
                valid_to_ms: optional_integer(fields, "valid_to_ms")?,
                recorded_at_ms: integer(fields, "recorded_at_ms")?,
            },
            scope_from_fields(fields)?,
            text(fields, "entity_type")?,
        ))
    }
}

/// Result of exact alias or lineage resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntityResolution {
    /// One unambiguous entity.
    Resolved(EntityId),
    /// Multiple valid targets; the caller must disambiguate.
    Ambiguous(Vec<EntityId>),
    /// No visible entity matched.
    NotFound,
}

/// Kind of append-only entity lineage event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityLineageType {
    /// One source redirects to one canonical target.
    MergedInto,
    /// One source branches into multiple targets.
    SplitInto,
}

impl EntityLineageType {
    fn as_str(self) -> &'static str {
        match self {
            Self::MergedInto => "merged_into",
            Self::SplitInto => "split_into",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "merged_into" => Some(Self::MergedInto),
            "split_into" => Some(Self::SplitInto),
            _ => None,
        }
    }
}

/// Request to append one entity merge or split.
#[derive(Clone, Debug)]
pub struct EntityLineageRequest {
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Entity whose resolution changes.
    pub source_entity_id: EntityId,
    /// Merge target or split targets.
    pub target_entity_ids: Vec<EntityId>,
    /// Merge or split.
    pub lineage_type: EntityLineageType,
    /// Valid-time effect.
    pub effective_at_ms: i64,
    /// Transaction time.
    pub recorded_at_ms: i64,
    /// Mandatory source evidence.
    pub evidence: Vec<GraphEvidenceInput>,
}

/// One append-only entity merge or split.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntityLineage {
    /// Stable event ID.
    pub id: String,
    /// Source entity.
    pub source_entity_id: EntityId,
    /// Resolution targets.
    pub target_entity_ids: Vec<EntityId>,
    /// Merge or split.
    pub lineage_type: EntityLineageType,
    /// Valid-time effect.
    pub effective_at_ms: i64,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

impl EntityLineage {
    pub(crate) fn from_request(request: &EntityLineageRequest) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"celiums-memory/entity-lineage/v1");
        hash_field(
            &mut hasher,
            b"source_entity_id",
            request.source_entity_id.as_str().as_bytes(),
        );
        for target in &request.target_entity_ids {
            hash_field(&mut hasher, b"target_entity_id", target.as_str().as_bytes());
        }
        hash_field(
            &mut hasher,
            b"lineage_type",
            request.lineage_type.as_str().as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"effective_at_ms",
            &request.effective_at_ms.to_le_bytes(),
        );
        Self {
            id: uuid_from_hash(hasher.finalize()).to_string(),
            source_entity_id: request.source_entity_id.clone(),
            target_entity_ids: request.target_entity_ids.clone(),
            lineage_type: request.lineage_type,
            effective_at_ms: request.effective_at_ms,
            recorded_at_ms: request.recorded_at_ms,
        }
    }

    pub(crate) fn prefix() -> &'static [u8] {
        LINEAGE_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self, scope: &RecallScope) -> Record {
        let mut fields = scope_fields(scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(LINEAGE_KIND)),
            ("id".to_owned(), string(&self.id)),
            (
                "source_entity_id".to_owned(),
                string(self.source_entity_id.as_str()),
            ),
            (
                "target_entity_ids".to_owned(),
                Value::Array(
                    self.target_entity_ids
                        .iter()
                        .map(|id| string(id.as_str()))
                        .collect(),
                ),
            ),
            (
                "lineage_type".to_owned(),
                string(self.lineage_type.as_str()),
            ),
            (
                "effective_at_ms".to_owned(),
                Value::Integer(self.effective_at_ms),
            ),
            (
                "recorded_at_ms".to_owned(),
                Value::Integer(self.recorded_at_ms),
            ),
        ]));
        Record::new(
            format!("{LINEAGE_PREFIX}{}", self.id).into_bytes(),
            Value::Object(fields),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<(Self, RecallScope), GraphDecodeError> {
        let fields = object(record, Self::prefix(), LINEAGE_KIND)?;
        Ok((
            Self {
                id: text(fields, "id")?,
                source_entity_id: EntityId::parse(text(fields, "source_entity_id")?)?,
                target_entity_ids: string_array(fields, "target_entity_ids")?
                    .into_iter()
                    .map(EntityId::parse)
                    .collect::<Result<Vec<_>, _>>()?,
                lineage_type: EntityLineageType::parse(&text(fields, "lineage_type")?).ok_or(
                    GraphDecodeError::Field {
                        field: "lineage_type",
                    },
                )?,
                effective_at_ms: integer(fields, "effective_at_ms")?,
                recorded_at_ms: integer(fields, "recorded_at_ms")?,
            },
            scope_from_fields(fields)?,
        ))
    }
}

/// Invalid graph request.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum InvalidGraph {
    /// Required text is invalid.
    #[error("graph {field} must be 1..=4096 bytes, trimmed, and contain no controls")]
    Text {
        /// Invalid component.
        field: &'static str,
    },
    /// Evidence is required.
    #[error("graph operation requires source evidence")]
    Evidence,
    /// Alias validity interval is empty or inverted.
    #[error("graph valid_from_ms must be earlier than valid_to_ms")]
    Validity,
    /// Merge/split target cardinality is invalid.
    #[error("graph lineage target cardinality does not match its type")]
    LineageTargets,
}

/// Failure decoding graph state.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum GraphDecodeError {
    /// Record key is outside the expected namespace.
    #[error("record key is outside the graph namespace")]
    Key,
    /// Required field is missing or invalid.
    #[error("graph document field `{field}` is missing, mistyped, or invalid")]
    Field {
        /// Invalid field.
        field: &'static str,
    },
}

pub(crate) fn validate_text(value: &str, field: &'static str) -> Result<(), InvalidGraph> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_TEXT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(InvalidGraph::Text { field });
    }
    Ok(())
}

pub(crate) fn validate_interval(from: Option<i64>, to: Option<i64>) -> Result<(), InvalidGraph> {
    if matches!((from, to), (Some(from), Some(to)) if from >= to) {
        return Err(InvalidGraph::Validity);
    }
    Ok(())
}

/// Unicode-lowercase exact normalization with collapsed whitespace.
pub fn normalize_label(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(crate) fn built_in_entity_type(value: &str) -> bool {
    matches!(value, "person" | "technology" | "project")
}

pub(crate) fn scope_visible(owner: &RecallScope, requested: &RecallScope) -> bool {
    owner.tenant_id == requested.tenant_id
        && owner.user_id == requested.user_id
        && owner.project_id == requested.project_id
        && owner.session_id == requested.session_id
}

fn object<'a>(
    record: &'a Record,
    prefix: &[u8],
    kind: &str,
) -> Result<&'a BTreeMap<String, Value>, GraphDecodeError> {
    if !record.key.starts_with(prefix) {
        return Err(GraphDecodeError::Key);
    }
    let Value::Object(fields) = &record.value else {
        return field_error("(root)");
    };
    if text(fields, "kind")? != kind {
        return field_error("kind");
    }
    Ok(fields)
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
        "session_id",
        scope.session_id.as_ref().map(SessionId::as_str),
    );
    fields
}

fn scope_from_fields(fields: &BTreeMap<String, Value>) -> Result<RecallScope, GraphDecodeError> {
    Ok(RecallScope {
        tenant_id: TenantId::new(text(fields, "tenant_id")?)
            .map_err(|_| GraphDecodeError::Field { field: "tenant_id" })?,
        user_id: UserId::new(text(fields, "user_id")?)
            .map_err(|_| GraphDecodeError::Field { field: "user_id" })?,
        project_id: optional_identity(fields, "project_id", ProjectId::new)?,
        conversation_id: None,
        session_id: optional_identity(fields, "session_id", SessionId::new)?,
    })
}

fn optional_identity<T>(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
    constructor: impl FnOnce(String) -> Result<T, crate::InvalidIdentity>,
) -> Result<Option<T>, GraphDecodeError> {
    optional_text(fields, field)?
        .map(|value| constructor(value).map_err(|_| GraphDecodeError::Field { field }))
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

fn text(fields: &BTreeMap<String, Value>, field: &'static str) -> Result<String, GraphDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => field_error(field),
    }
}

fn optional_text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<String>, GraphDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => field_error(field),
    }
}

fn integer(fields: &BTreeMap<String, Value>, field: &'static str) -> Result<i64, GraphDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => field_error(field),
    }
}

fn optional_integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<i64>, GraphDecodeError> {
    match fields.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::Integer(value)) => Ok(Some(*value)),
        _ => field_error(field),
    }
}

fn unsigned(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<u64, GraphDecodeError> {
    integer(fields, field)?
        .try_into()
        .map_err(|_| GraphDecodeError::Field { field })
}

fn string_array(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<String>, GraphDecodeError> {
    match fields.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                _ => field_error(field),
            })
            .collect(),
        _ => field_error(field),
    }
}

fn field_error<T>(field: &'static str) -> Result<T, GraphDecodeError> {
    Err(GraphDecodeError::Field { field })
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
