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
const RELATION_TYPE_KIND: &str = "relation_type";
const RELATION_TYPE_PREFIX: &str = "__celiums/graph/ontology/relation_type/";
const RELATION_KIND: &str = "entity_relation";
const RELATION_PREFIX: &str = "__celiums/graph/relation/";
const MEMORY_BINDING_KIND: &str = "graph_memory_binding";
const MEMORY_BINDING_PREFIX: &str = "__celiums/graph/memory_binding/";
const MAX_TEXT_BYTES: usize = 4_096;
const NANOS: f64 = 1_000_000_000.0;

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
graph_id!(EntityRelationId, "entity_relation_id");

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
    /// Immutable source evidence.
    pub evidence: Vec<GraphEvidenceInput>,
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
            evidence: request.evidence.clone(),
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
            ("evidence".to_owned(), evidence_value(&self.evidence)),
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
            evidence: evidence_from_value(
                fields
                    .get("evidence")
                    .ok_or(GraphDecodeError::Field { field: "evidence" })?,
            )?,
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
    /// Optional immutable source evidence.
    pub evidence: Vec<GraphEvidenceInput>,
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
            evidence: request.evidence.clone(),
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
            ("evidence".to_owned(), evidence_value(&self.evidence)),
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
                evidence: evidence_from_value(
                    fields
                        .get("evidence")
                        .ok_or(GraphDecodeError::Field { field: "evidence" })?,
                )?,
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
    /// Immutable evidence for the merge or split.
    pub evidence: Vec<GraphEvidenceInput>,
}

/// Whether a relation has an intrinsic direction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RelationDirection {
    /// Source and target roles differ.
    Directed,
    /// Either endpoint may be traversed as the source.
    Undirected,
}

impl RelationDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Directed => "directed",
            Self::Undirected => "undirected",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "directed" => Some(Self::Directed),
            "undirected" => Some(Self::Undirected),
            _ => None,
        }
    }
}

/// Request to define one typed relation in an ontology version.
#[derive(Clone, Debug)]
pub struct DefineRelationTypeRequest {
    /// Owning scope.
    pub scope: RecallScope,
    /// Stable relation type ID.
    pub relation_type: String,
    /// Permitted source entity types.
    pub source_entity_types: Vec<String>,
    /// Permitted target entity types.
    pub target_entity_types: Vec<String>,
    /// Directed or undirected semantics.
    pub direction: RelationDirection,
    /// Whether online traversal may follow this edge type.
    pub traversable: bool,
    /// Immutable ontology version.
    pub ontology_version: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

/// Durable typed relation definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelationTypeDefinition {
    /// Owning scope.
    pub scope: RecallScope,
    /// Stable relation type ID.
    pub relation_type: String,
    /// Permitted source types.
    pub source_entity_types: Vec<String>,
    /// Permitted target types.
    pub target_entity_types: Vec<String>,
    /// Direction semantics.
    pub direction: RelationDirection,
    /// Traversal permission.
    pub traversable: bool,
    /// Ontology version.
    pub ontology_version: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

impl RelationTypeDefinition {
    pub(crate) fn from_request(request: DefineRelationTypeRequest) -> Self {
        Self {
            scope: request.scope,
            relation_type: request.relation_type,
            source_entity_types: request.source_entity_types,
            target_entity_types: request.target_entity_types,
            direction: request.direction,
            traversable: request.traversable,
            ontology_version: request.ontology_version,
            recorded_at_ms: request.recorded_at_ms,
        }
    }

    pub(crate) fn prefix() -> &'static [u8] {
        RELATION_TYPE_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut hasher = blake3::Hasher::new();
        hash_scope(&mut hasher, &self.scope);
        hash_field(&mut hasher, b"relation_type", self.relation_type.as_bytes());
        hash_field(
            &mut hasher,
            b"ontology_version",
            self.ontology_version.as_bytes(),
        );
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(RELATION_TYPE_KIND)),
            ("relation_type".to_owned(), string(&self.relation_type)),
            (
                "source_entity_types".to_owned(),
                string_array_value(&self.source_entity_types),
            ),
            (
                "target_entity_types".to_owned(),
                string_array_value(&self.target_entity_types),
            ),
            ("direction".to_owned(), string(self.direction.as_str())),
            (
                "traversable".to_owned(),
                Value::Integer(i64::from(self.traversable)),
            ),
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
            format!("{RELATION_TYPE_PREFIX}{}", hasher.finalize().to_hex()).into_bytes(),
            Value::Object(fields),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, GraphDecodeError> {
        let fields = object(record, Self::prefix(), RELATION_TYPE_KIND)?;
        Ok(Self {
            scope: scope_from_fields(fields)?,
            relation_type: text(fields, "relation_type")?,
            source_entity_types: string_array(fields, "source_entity_types")?,
            target_entity_types: string_array(fields, "target_entity_types")?,
            direction: RelationDirection::parse(&text(fields, "direction")?)
                .ok_or(GraphDecodeError::Field { field: "direction" })?,
            traversable: boolean(fields, "traversable")?,
            ontology_version: text(fields, "ontology_version")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
        })
    }
}

/// Request to create one evidence-backed temporal entity relation.
#[derive(Clone, Debug)]
pub struct CreateEntityRelationRequest {
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Source endpoint.
    pub source_entity_id: EntityId,
    /// Typed relation ID.
    pub relation_type: String,
    /// Target endpoint.
    pub target_entity_id: EntityId,
    /// Confidence in `[0, 1]`.
    pub confidence: f64,
    /// Inclusive valid-time start.
    pub valid_from_ms: Option<i64>,
    /// Exclusive valid-time end.
    pub valid_to_ms: Option<i64>,
    /// Transaction time.
    pub recorded_at_ms: i64,
    /// Mandatory immutable evidence.
    pub evidence: Vec<GraphEvidenceInput>,
}

/// Durable typed temporal edge.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntityRelation {
    /// Stable edge identity.
    pub id: EntityRelationId,
    /// Owning scope.
    pub scope: RecallScope,
    /// Source endpoint.
    pub source_entity_id: EntityId,
    /// Relation type.
    pub relation_type: String,
    /// Target endpoint.
    pub target_entity_id: EntityId,
    /// Ontology version used to validate this edge.
    pub ontology_version: String,
    /// Direction copied from the ontology definition.
    pub direction: RelationDirection,
    /// Whether traversal may follow this edge.
    pub traversable: bool,
    /// Deterministic confidence nanos.
    pub confidence_nanos: i64,
    /// Inclusive validity start.
    pub valid_from_ms: Option<i64>,
    /// Exclusive validity end.
    pub valid_to_ms: Option<i64>,
    /// Transaction time.
    pub recorded_at_ms: i64,
    /// Immutable source evidence.
    pub evidence: Vec<GraphEvidenceInput>,
    /// Cached evidence count for integrity checks.
    pub evidence_count: u64,
}

/// Explicit reason a bounded graph traversal stopped early.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphTruncationReason {
    /// A reachable neighbor lay beyond `max_depth`.
    Depth,
    /// Expanding another edge would exceed `max_edges`.
    Edges,
    /// Enqueueing another entity would exceed `max_entities`.
    Entities,
}

/// Deterministic bounded traversal request.
#[derive(Clone, Debug)]
pub struct GraphTraversalRequest {
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Starting entity IDs.
    pub seeds: Vec<EntityId>,
    /// Empty means all traversable ontology relations.
    pub relation_types: Vec<String>,
    /// Valid-time point.
    pub valid_at_ms: i64,
    /// Transaction-time cutoff.
    pub known_at_ms: i64,
    /// Maximum edge depth from seeds.
    pub max_depth: usize,
    /// Maximum traversed edge count.
    pub max_edges: usize,
    /// Maximum visited entity count.
    pub max_entities: usize,
}

/// One traversed edge and its path depth.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TraversedEdge {
    /// Edge state.
    pub relation: EntityRelation,
    /// Depth reached after following this edge.
    pub depth: usize,
}

/// Complete bounded traversal result with cost and truncation evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphTraversalResult {
    /// Visited entities in deterministic BFS order.
    pub entities: Vec<EntityId>,
    /// Traversed edges in deterministic BFS order.
    pub edges: Vec<TraversedEdge>,
    /// Number of visible edges inspected.
    pub inspected_edges: usize,
    /// Whether any budget prevented full expansion.
    pub truncated: bool,
    /// First budget that truncated traversal.
    pub truncation_reason: Option<GraphTruncationReason>,
}

/// Durable scoped association between a canonical entity and memory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphMemoryBinding {
    /// Owning scope.
    pub scope: RecallScope,
    /// Bound entity.
    pub entity_id: EntityId,
    /// Bound memory ID.
    pub memory_id: String,
    /// Transaction time.
    pub recorded_at_ms: i64,
}

/// One graph integrity violation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphIntegrityIssue {
    /// Stable machine-readable issue kind.
    pub kind: String,
    /// Offending record or referenced ID.
    pub subject_id: String,
}

/// Complete explicit graph integrity report.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GraphIntegrityReport {
    /// True when no issue was found.
    pub valid: bool,
    /// Visible canonical entities inspected.
    pub entity_count: usize,
    /// Visible temporal relations inspected.
    pub relation_count: usize,
    /// Visible memory bindings inspected.
    pub binding_count: usize,
    /// All detected issues.
    pub issues: Vec<GraphIntegrityIssue>,
}

impl GraphMemoryBinding {
    pub(crate) fn new(
        scope: RecallScope,
        entity_id: EntityId,
        memory_id: String,
        recorded_at_ms: i64,
    ) -> Self {
        Self {
            scope,
            entity_id,
            memory_id,
            recorded_at_ms,
        }
    }

    pub(crate) fn prefix() -> &'static [u8] {
        MEMORY_BINDING_PREFIX.as_bytes()
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut hasher = blake3::Hasher::new();
        hash_scope(&mut hasher, &self.scope);
        hash_field(
            &mut hasher,
            b"entity_id",
            self.entity_id.as_str().as_bytes(),
        );
        hash_field(&mut hasher, b"memory_id", self.memory_id.as_bytes());
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(MEMORY_BINDING_KIND)),
            ("entity_id".to_owned(), string(self.entity_id.as_str())),
            ("memory_id".to_owned(), string(&self.memory_id)),
            (
                "recorded_at_ms".to_owned(),
                Value::Integer(self.recorded_at_ms),
            ),
        ]));
        Record::new(
            format!("{MEMORY_BINDING_PREFIX}{}", hasher.finalize().to_hex()).into_bytes(),
            Value::Object(fields),
        )
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, GraphDecodeError> {
        let fields = object(record, Self::prefix(), MEMORY_BINDING_KIND)?;
        Ok(Self {
            scope: scope_from_fields(fields)?,
            entity_id: EntityId::parse(text(fields, "entity_id")?)?,
            memory_id: text(fields, "memory_id")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
        })
    }
}

impl EntityRelation {
    pub(crate) fn from_request(
        request: &CreateEntityRelationRequest,
        definition: &RelationTypeDefinition,
    ) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"celiums-memory/entity-relation/v1");
        hash_scope(&mut hasher, &request.scope);
        hash_field(
            &mut hasher,
            b"source_entity_id",
            request.source_entity_id.as_str().as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"relation_type",
            request.relation_type.as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"target_entity_id",
            request.target_entity_id.as_str().as_bytes(),
        );
        hash_field(
            &mut hasher,
            b"ontology_version",
            definition.ontology_version.as_bytes(),
        );
        hash_optional_i64(&mut hasher, b"valid_from_ms", request.valid_from_ms);
        hash_optional_i64(&mut hasher, b"valid_to_ms", request.valid_to_ms);
        for item in &request.evidence {
            hash_field(&mut hasher, b"event_id", item.event_id.as_str().as_bytes());
            hash_optional(&mut hasher, b"excerpt", item.excerpt.as_deref());
        }
        Self {
            id: EntityRelationId(uuid_from_hash(hasher.finalize()).to_string()),
            scope: request.scope.clone(),
            source_entity_id: request.source_entity_id.clone(),
            relation_type: request.relation_type.clone(),
            target_entity_id: request.target_entity_id.clone(),
            ontology_version: definition.ontology_version.clone(),
            direction: definition.direction,
            traversable: definition.traversable,
            confidence_nanos: scalar_nanos(request.confidence),
            valid_from_ms: request.valid_from_ms,
            valid_to_ms: request.valid_to_ms,
            recorded_at_ms: request.recorded_at_ms,
            evidence: request.evidence.clone(),
            evidence_count: request.evidence.len() as u64,
        }
    }

    pub(crate) fn key(id: &EntityRelationId) -> Vec<u8> {
        format!("{RELATION_PREFIX}{id}").into_bytes()
    }

    pub(crate) fn prefix() -> &'static [u8] {
        RELATION_PREFIX.as_bytes()
    }

    pub(crate) fn valid_at(&self, valid_at_ms: i64, known_at_ms: i64) -> bool {
        self.recorded_at_ms <= known_at_ms
            && self.valid_from_ms.is_none_or(|from| from <= valid_at_ms)
            && self.valid_to_ms.is_none_or(|to| valid_at_ms < to)
    }

    pub(crate) fn to_record(&self) -> Record {
        let mut fields = scope_fields(&self.scope);
        fields.extend(BTreeMap::from([
            ("kind".to_owned(), string(RELATION_KIND)),
            ("relation_id".to_owned(), string(self.id.as_str())),
            (
                "source_entity_id".to_owned(),
                string(self.source_entity_id.as_str()),
            ),
            ("relation_type".to_owned(), string(&self.relation_type)),
            (
                "target_entity_id".to_owned(),
                string(self.target_entity_id.as_str()),
            ),
            (
                "ontology_version".to_owned(),
                string(&self.ontology_version),
            ),
            ("direction".to_owned(), string(self.direction.as_str())),
            (
                "traversable".to_owned(),
                Value::Integer(i64::from(self.traversable)),
            ),
            (
                "confidence_nanos".to_owned(),
                Value::Integer(self.confidence_nanos),
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
            ("evidence".to_owned(), evidence_value(&self.evidence)),
            (
                "evidence_count".to_owned(),
                Value::Integer(i64::try_from(self.evidence_count).unwrap_or(i64::MAX)),
            ),
        ]));
        Record::new(Self::key(&self.id), Value::Object(fields))
    }

    pub(crate) fn from_record(record: &Record) -> Result<Self, GraphDecodeError> {
        let fields = object(record, Self::prefix(), RELATION_KIND)?;
        Ok(Self {
            id: EntityRelationId::parse(text(fields, "relation_id")?)?,
            scope: scope_from_fields(fields)?,
            source_entity_id: EntityId::parse(text(fields, "source_entity_id")?)?,
            relation_type: text(fields, "relation_type")?,
            target_entity_id: EntityId::parse(text(fields, "target_entity_id")?)?,
            ontology_version: text(fields, "ontology_version")?,
            direction: RelationDirection::parse(&text(fields, "direction")?)
                .ok_or(GraphDecodeError::Field { field: "direction" })?,
            traversable: boolean(fields, "traversable")?,
            confidence_nanos: integer(fields, "confidence_nanos")?,
            valid_from_ms: optional_integer(fields, "valid_from_ms")?,
            valid_to_ms: optional_integer(fields, "valid_to_ms")?,
            recorded_at_ms: integer(fields, "recorded_at_ms")?,
            evidence: evidence_from_value(
                fields
                    .get("evidence")
                    .ok_or(GraphDecodeError::Field { field: "evidence" })?,
            )?,
            evidence_count: unsigned(fields, "evidence_count")?,
        })
    }
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
            evidence: request.evidence.clone(),
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
            ("evidence".to_owned(), evidence_value(&self.evidence)),
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
                evidence: evidence_from_value(
                    fields
                        .get("evidence")
                        .ok_or(GraphDecodeError::Field { field: "evidence" })?,
                )?,
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

fn string_array_value(values: &[String]) -> Value {
    Value::Array(values.iter().map(|value| string(value)).collect())
}

fn boolean(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<bool, GraphDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(0)) => Ok(false),
        Some(Value::Integer(1)) => Ok(true),
        _ => field_error(field),
    }
}

fn evidence_value(evidence: &[GraphEvidenceInput]) -> Value {
    Value::Array(
        evidence
            .iter()
            .map(|item| {
                Value::Object(BTreeMap::from([
                    ("event_id".to_owned(), string(item.event_id.as_str())),
                    (
                        "excerpt".to_owned(),
                        item.excerpt.as_deref().map_or(Value::Null, string),
                    ),
                ]))
            })
            .collect(),
    )
}

fn evidence_from_value(value: &Value) -> Result<Vec<GraphEvidenceInput>, GraphDecodeError> {
    let Value::Array(values) = value else {
        return field_error("evidence");
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(fields) = value else {
                return field_error("evidence");
            };
            Ok(GraphEvidenceInput {
                event_id: EventId::parse(text(fields, "event_id")?)
                    .map_err(|_| GraphDecodeError::Field { field: "event_id" })?,
                excerpt: optional_text(fields, "excerpt")?,
            })
        })
        .collect()
}

fn scalar_nanos(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value * NANOS).round() as i64
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
