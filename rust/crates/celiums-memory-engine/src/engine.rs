// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The Celiums Memory engine: durable remember/recall on top of Hyphae.
//!
//! Layering (mirrors the TypeScript pipeline in `recall.ts`):
//!
//! 1. Hyphae supplies the two retrieval branches — exact Q15 cosine
//!    (semantic) and BM25F (text match) — plus the durable, hash-chained
//!    store underneath.
//! 2. The candidate union of both branches is re-ranked with the
//!    six-channel cognitive formula from `celiums-cognition`.
//! 3. Recalled memories are reactivated (spaced repetition), stretching
//!    their forgetting curve.
//!
//! Branch abstentions are preserved and surfaced, never collapsed into
//! a silently empty result — the mycelium-do `/health/recall` lesson.

use std::collections::BTreeMap;
use std::path::Path;

use celiums_cognition::{
    ActivityRhythm, ChannelScores, CircadianConfig, CircadianEvent, EthicsViolation, FactorWeights,
    JournalEntryType, LimbicConfig, MemoryInfluence, MemoryPurpose, MemoryState, Pad,
    RecallWeights, Scope, SourceTrust, SupersessionRelation, Treatment, circadian,
    classify_governance, classify_importance, classify_memory_type, emotional_weight,
    evaluate_ethics, extract_entities, extract_pad, infer_activity_rhythm, is_valid_agent_id,
    limbic, recall, resonance, retention, retrievability,
};
use hyphae_core::{Q15Vector, VectorSpaceDefinition, VectorSpaceName, VectorValueError};
use hyphae_engine::{EngineError as HyphaeError, HyphaeEngine};
use hyphae_query::FieldPath;
use hyphae_retrieval::{
    ExactAbstentionReason, ExactRetrievalLimits, ExactRetrievalOutcome, ExactRetrievalRequest,
    LexicalAbstentionReason, LexicalField, LexicalIndexDefinition, LexicalLimits, LexicalOutcome,
    LexicalRequest,
};
use thiserror::Error;
use uuid::Uuid;

use crate::affect_state::{AFFECT_STATE_KEY, AffectState};
use crate::circadian_state::{CIRCADIAN_STATE_KEY, CircadianState};
use crate::claim::{
    Claim, ClaimContradiction, ClaimContradictionKind, ClaimDecodeError, ClaimEvidence, ClaimId,
    ClaimPropertyQuery, ClaimSupersession, ClaimSupersessionRelation, CreateClaimRequest,
    InvalidClaim, SupersedeClaimRequest, validity_overlap,
};
use crate::derived::{
    ClaimAggregate, ClaimAggregateStatus, ConsolidateClaimsRequest, ConsolidateSummaryRequest,
    ConsolidateTurnRequest, ConsolidationAction, ConsolidationPlan, ConsolidationPlanRequest,
    ConsolidationRun, ConsolidationRunStatus, ConsolidationSchedule, ConsolidationScheduleRequest,
    DerivedDecodeError, DerivedId, DerivedIntegrityIssue, DerivedIntegrityReport, DerivedKind,
    DerivedMemory, DerivedMetrics, DerivedSource, ForgetDerivedSourceRequest,
    ForgetPropagationReport, ForgottenDerivedSource, InvalidDerived, NewDerivedMemory,
    RollbackReport, source_digest, validate_text as validate_derived_text,
};
use crate::embedding_space::{EMBEDDING_SPACE_KEY, EmbeddingSpaceIdentity};
use crate::entity_index::{EntityRecord, entity_key, entity_prefix};
use crate::filter::authorization_filter;
use crate::filter::{MemoryFilter, MemoryFilterError};
use crate::governance_audit::{
    AuditDecision, EthicsAuditEntry, FeedbackEntry, FeedbackKind, FeedbackResolution,
    GovernedOperation, ReviewDisposition, ReviewState, audit_prefix, feedback_prefix,
};
use crate::governance_state::MemoryGovernance;
use crate::graph::{
    CanonicalEntity, CreateEntityRelationRequest, CreateEntityRequest, DefineEntityTypeRequest,
    DefineRelationTypeRequest, EntityAlias, EntityAliasRequest, EntityId, EntityLineage,
    EntityLineageRequest, EntityLineageType, EntityRelation, EntityResolution,
    EntityTypeDefinition, GraphDecodeError, GraphIntegrityIssue, GraphIntegrityReport,
    GraphMemoryBinding, GraphTraversalRequest, GraphTraversalResult, GraphTruncationReason,
    InvalidGraph, RelationDirection, RelationTypeDefinition, TraversedEdge, built_in_entity_type,
    normalize_label, scope_visible as graph_scope_visible, validate_interval,
    validate_text as validate_graph_text,
};
use crate::idempotency::{
    IdempotencyDecodeError, IdempotencyKey, RememberIdempotencyRecord, canonical_remember_hash,
    deterministic_remember_uuid,
};
use crate::identity::{RecallScope, RememberContext, TenantId};
use crate::ingestion::{
    BatchId, BatchItemOutcome, EventId, IngestionBatch, IngestionCoverage, IngestionDecodeError,
    IngestionEntry, IngestionStatus, SourceEventId, SourceNamespace, TurnId,
};
use crate::journal::{
    BrokenLink, BrokenReason, ChainReport, JournalEntry, MAX_VALENCE_REASON_CHARS, Supersession,
    agent_prefix, chain_hash, entry_key, supersession_prefix,
};
use crate::memory::{Memory, MemoryDecodeError};
use crate::quantize::{QuantizeError, quantize};
use crate::temporal::{ClaimSnapshot, EventTimeBasis, SequencedEvent, snapshot_entry};

/// Named vector space holding memory embeddings.
const MEMORY_SPACE: &str = "memories";
/// Named lexical index over memory content.
const CONTENT_INDEX: &str = "content";
/// Semantic candidate floor, the TS `semanticSearch` threshold 0.2
/// expressed in score nanos (recall.ts:131).
const CANDIDATE_SCORE_NANOS: i64 = 200_000_000;
/// Candidate over-fetch factor: fetch more, filter after cognitive
/// scoring (recall.ts:130).
const CANDIDATE_FACTOR: usize = 2;
/// How many top results are reactivated per recall (recall.ts:271).
const REACTIVATION_TOP: usize = 10;
/// Cosine similarity above which two memories are duplicates
/// (consolidate.ts:52 `deduplicationThreshold: 0.92`), in nanos.
const DEDUP_SCORE_NANOS: i64 = 920_000_000;
/// Duplicate candidates fetched per line (consolidate.ts:104).
const DEDUP_CANDIDATES: usize = 3;
/// Minimum importance for a line to become a memory
/// (consolidate.ts:53).
const MIN_CONSOLIDATION_IMPORTANCE: f64 = 0.2;
/// Lines shorter than this are noise (consolidate.ts:83).
const MIN_CONSOLIDATION_LINE_CHARS: usize = 20;
/// Cap of lines per consolidation pass (consolidate.ts:54).
const MAX_LINES_PER_CONSOLIDATION: usize = 50;
/// Strength granted to a memory confirmed by consolidation
/// (consolidate.ts:113).
const CONSOLIDATION_STRENGTH: f64 = 1.2;
/// Lifecycle floor: importance never decays below this
/// (lifecycle.ts:74).
const MIN_IMPORTANCE: f64 = 0.01;
/// Lifecycle pagination batch (getForLifecycle batchSize).
const LIFECYCLE_BATCH: usize = 200;
/// Transparent graph contribution for graph-derived candidates.
const GRAPH_CANDIDATE_WEIGHT: f64 = 1.0;

/// Failure while operating the memory engine.
#[derive(Debug, Error)]
pub enum MemoryEngineError {
    /// The underlying Hyphae engine failed.
    #[error(transparent)]
    Hyphae(#[from] HyphaeError),
    /// Embedding quantisation failed (dimension guard included).
    #[error(transparent)]
    Quantize(#[from] QuantizeError),
    /// A stored memory could not be decoded.
    #[error(transparent)]
    Decode(#[from] MemoryDecodeError),
    /// The canonical vector domain rejected a configuration value.
    #[error(transparent)]
    Vector(#[from] VectorValueError),
    /// A recalled candidate key had no backing record — index and log
    /// disagree, which must be investigated, not skipped.
    #[error("candidate memory `{id}` has no backing record")]
    MissingCandidate {
        /// Offending memory id.
        id: String,
    },
    /// The agent id violates the P0 §3.1 journal-isolation contract.
    #[error(
        "invalid agent_id `{agent_id}` — must match [A-Za-z0-9_:.\\-]{{1,128}}; \
         refusing to write into a shared bucket"
    )]
    InvalidAgentId {
        /// Rejected candidate (truncated by the caller if huge).
        agent_id: String,
    },
    /// A snapshot could not be verified, loaded or interpreted.
    #[error("snapshot failure: {detail}")]
    Snapshot {
        /// What failed.
        detail: String,
    },
    /// The ethics write-gate blocked the content. Nothing was stored.
    #[error("memory blocked by the ethics engine: {category}")]
    EthicsBlocked {
        /// Blocking category id.
        category: String,
        /// All violations, for audit.
        violations: Vec<EthicsViolation>,
    },
    /// Provenance claimed a content digest that does not match the write.
    #[error("provenance content hash does not match remembered content")]
    ContentHashMismatch,
    /// A request tried to cross the physical tenant boundary of this engine.
    #[error("request tenant `{requested}` does not match engine tenant `{engine}`")]
    TenantMismatch {
        /// Tenant supplied by the request.
        requested: String,
        /// Tenant physically bound to the engine.
        engine: String,
    },
    /// A request used vectors from a different model/revision/space.
    #[error("embedding space mismatch: expected {expected}, received {received}")]
    EmbeddingSpaceMismatch {
        /// Space configured for this engine.
        expected: String,
        /// Space claimed by the request.
        received: String,
    },
    /// The idempotency key was already used for a different request.
    #[error("idempotency key was already used with a different remember request")]
    IdempotencyConflict,
    /// The idempotency ledger points to a missing memory.
    #[error("idempotency record points to missing memory `{id}`")]
    BrokenIdempotencyReference {
        /// Missing memory id.
        id: String,
    },
    /// A durable idempotency record was malformed.
    #[error(transparent)]
    IdempotencyDecode(#[from] IdempotencyDecodeError),
    /// A source event identity was reused for another immutable payload.
    #[error("source event `{event_id}` was already ingested with a different payload")]
    IngestionConflict {
        /// Stable engine event ID in conflict.
        event_id: String,
    },
    /// A batch ID was reused with different ordered event membership.
    #[error("ingestion batch `{batch_id}` was already submitted with different events")]
    IngestionBatchConflict {
        /// Caller-assigned batch ID in conflict.
        batch_id: String,
    },
    /// A batch is empty or mixes physical/logical owners.
    #[error("invalid ingestion batch: {detail}")]
    InvalidIngestionBatch {
        /// Actionable validation detail.
        detail: &'static str,
    },
    /// One event does not belong to the declared conversation.
    #[error("ingestion event at index {index} does not match the declared conversation")]
    ConversationMismatch {
        /// Invalid input index.
        index: usize,
    },
    /// A visible ingestion event could not be found for enrichment.
    #[error("ingestion event `{event_id}` was not found in the requested scope")]
    IngestionEventNotFound {
        /// Missing stable event ID.
        event_id: String,
    },
    /// A durable ingestion ledger record was malformed.
    #[error(transparent)]
    IngestionDecode(#[from] IngestionDecodeError),
    /// A claim request violated the canonical contract.
    #[error(transparent)]
    InvalidClaim(#[from] InvalidClaim),
    /// A durable claim record could not be decoded.
    #[error(transparent)]
    ClaimDecode(#[from] ClaimDecodeError),
    /// One requested source event was missing or outside the claim scope.
    #[error("claim evidence event `{event_id}` was not found in the requested scope")]
    ClaimEvidenceNotFound {
        /// Missing event ID.
        event_id: String,
    },
    /// A deterministic claim ID resolved to different immutable claim data.
    #[error("claim `{claim_id}` already exists with different immutable data")]
    ClaimConflict {
        /// Stable claim ID in conflict.
        claim_id: String,
    },
    /// An evidence excerpt did not occur in the immutable raw event.
    #[error("claim evidence excerpt does not occur in event `{event_id}`")]
    ClaimEvidenceExcerptMismatch {
        /// Source event with the mismatched excerpt.
        event_id: String,
    },
    /// A supersession attempted to connect different canonical properties.
    #[error("claim supersession requires the same subject and predicate")]
    ClaimPropertyMismatch,
    /// A supersession relation requires a successor but none was supplied.
    #[error("claim supersession relation requires a successor claim")]
    ClaimSuccessorRequired,
    /// A claim supersession would create a cycle.
    #[error("claim supersession would create a cycle")]
    ClaimSupersessionCycle,
    /// A claim referenced by a temporal operation was not visible.
    #[error("claim `{claim_id}` was not found in the requested scope")]
    ClaimNotFound {
        /// Missing claim ID.
        claim_id: String,
    },
    /// A graph request violated canonical validation.
    #[error(transparent)]
    InvalidGraph(#[from] InvalidGraph),
    /// A durable graph record was malformed.
    #[error(transparent)]
    GraphDecode(#[from] GraphDecodeError),
    /// One graph entity was missing or hidden.
    #[error("graph entity `{entity_id}` was not found in the requested scope")]
    GraphEntityNotFound {
        /// Missing entity ID.
        entity_id: String,
    },
    /// An ontology entity type is unknown.
    #[error("graph entity type `{entity_type}` is not defined")]
    GraphEntityTypeNotFound {
        /// Missing type ID.
        entity_type: String,
    },
    /// A graph evidence event was missing or hidden.
    #[error("graph evidence event `{event_id}` was not found in the requested scope")]
    GraphEvidenceNotFound {
        /// Missing event ID.
        event_id: String,
    },
    /// A graph evidence excerpt did not occur in the immutable raw event.
    #[error("graph evidence excerpt does not occur in event `{event_id}`")]
    GraphEvidenceExcerptMismatch {
        /// Source event ID.
        event_id: String,
    },
    /// Entity lineage would form a redirect cycle.
    #[error("entity lineage would create a cycle")]
    GraphLineageCycle,
    /// One relation endpoint does not satisfy the ontology definition.
    #[error("graph relation endpoint types do not satisfy the ontology")]
    GraphRelationEndpointType,
    /// A graph relation type is unknown.
    #[error("graph relation type `{relation_type}` is not defined")]
    GraphRelationTypeNotFound {
        /// Missing relation type ID.
        relation_type: String,
    },
    /// A derived-memory request violated validation.
    #[error(transparent)]
    InvalidDerived(#[from] InvalidDerived),
    /// Durable derived state was malformed.
    #[error(transparent)]
    DerivedDecode(#[from] DerivedDecodeError),
    /// No visible source matched a consolidation request.
    #[error("consolidation request has no visible source records")]
    ConsolidationSourcesEmpty,
    /// A supplied plan no longer matches its immutable source set.
    #[error("consolidation plan no longer matches its source records")]
    ConsolidationPlanConflict,
    /// A canonical memory filter was invalid.
    #[error(transparent)]
    Filter(#[from] MemoryFilterError),
    /// An optimistic-concurrency revision did not match.
    #[error("memory revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict {
        /// Revision supplied by the caller.
        expected: u64,
        /// Current durable revision.
        actual: u64,
    },
    /// A requested patch had no mutable fields.
    #[error("memory update patch has no changes")]
    EmptyPatch,
    /// A referenced journal entry does not exist for this agent.
    #[error("journal entry `{entry_id}` not found for agent `{agent_id}`")]
    JournalEntryNotFound {
        /// Owning agent.
        agent_id: String,
        /// Missing entry.
        entry_id: String,
    },
}

/// Tuning for the recall pipeline. Defaults mirror the TypeScript
/// production configuration (recall.ts:49-68).
#[derive(Clone, Copy, Debug)]
pub struct RecallConfig {
    /// Channel weights of the cognitive formula.
    pub weights: RecallWeights,
    /// Minimum final score for inclusion.
    pub score_threshold: f64,
    /// Maximum memories returned.
    pub max_results: usize,
    /// Whether recalled memories are reactivated (spaced repetition).
    pub enable_reactivation: bool,
}

impl Default for RecallConfig {
    fn default() -> Self {
        Self {
            weights: RecallWeights::default(),
            score_threshold: 0.15,
            max_results: 30,
            enable_reactivation: true,
        }
    }
}

/// A request to store one memory.
#[derive(Clone, Debug)]
pub struct RememberRequest {
    /// Raw text to remember.
    pub content: String,
    /// Caller-provided embedding of `content`, unit-normalised floats.
    pub embedding: Vec<f32>,
    /// Free-form tags.
    pub tags: Vec<String>,
    /// Visibility scope.
    pub scope: Scope,
    /// Explicit importance override; `None` classifies from content.
    pub importance: Option<f64>,
    /// Current time, Unix milliseconds. Explicit for determinism.
    pub now_ms: i64,
    /// Identity, provenance and source clocks. Local context is used when absent.
    pub context: Option<RememberContext>,
    /// Space that produced `embedding`. Engine default is used when absent.
    pub embedding_space: Option<EmbeddingSpaceIdentity>,
    /// Caller key for retry-safe creation.
    pub idempotency_key: Option<IdempotencyKey>,
    /// How the content functions: observation, description, or requested action.
    pub content_role: celiums_cognition::ContentRole,
    /// Why the memory is being retained.
    pub purpose: MemoryPurpose,
}

/// One raw source event submitted at the durable ingestion boundary.
#[derive(Clone, Debug)]
pub struct IngestEventRequest {
    /// Integration namespace that owns `source_event_id`.
    pub source_namespace: SourceNamespace,
    /// Stable event identifier assigned by the source.
    pub source_event_id: SourceEventId,
    /// Optional grouping identity shared by events in one turn.
    pub turn_id: Option<TurnId>,
    /// Event role or origin class.
    pub source_kind: crate::SourceKind,
    /// Optional address of the source event.
    pub source_uri: Option<String>,
    /// Optional source actor label.
    pub actor: Option<String>,
    /// Physical and logical ownership.
    pub identity: crate::MemoryIdentity,
    /// Exact raw text received from the source.
    pub content: String,
    /// Source event time, when known.
    pub event_at_ms: Option<i64>,
    /// Engine boundary time, explicit for deterministic operation.
    pub ingested_at_ms: i64,
    /// Optional embedding; absent events remain durably received.
    pub embedding: Option<Vec<f32>>,
    /// Space that produced `embedding`.
    pub embedding_space: Option<EmbeddingSpaceIdentity>,
    /// Free-form tags for a materialized memory.
    pub tags: Vec<String>,
    /// Visibility scope for a materialized memory.
    pub scope: Scope,
    /// Explicit importance override.
    pub importance: Option<f64>,
    /// How the content functions under governance.
    pub content_role: celiums_cognition::ContentRole,
    /// Why the event is retained or used.
    pub purpose: MemoryPurpose,
}

/// One durable, independently accounted ingestion batch.
#[derive(Clone, Debug)]
pub struct IngestBatchRequest {
    /// Stable caller-assigned job ID.
    pub batch_id: BatchId,
    /// Ordered events. Membership is immutable across retries.
    pub events: Vec<IngestEventRequest>,
    /// Submission time.
    pub now_ms: i64,
}

/// Conversation ingestion validates every event before starting the batch.
#[derive(Clone, Debug)]
pub struct IngestConversationRequest {
    /// Conversation shared by every event.
    pub conversation_id: crate::ConversationId,
    /// Durable batch request.
    pub batch: IngestBatchRequest,
}

/// Provider output used to resume one durable raw event.
#[derive(Clone, Debug)]
pub struct EnrichEventRequest {
    /// Stable engine event ID.
    pub event_id: EventId,
    /// Authorized event owner.
    pub scope: RecallScope,
    /// Provider/runtime name used for this attempt.
    pub provider: String,
    /// Provider-produced embedding.
    pub embedding: Vec<f32>,
    /// Complete embedding-space identity when not using the engine default.
    pub embedding_space: Option<EmbeddingSpaceIdentity>,
    /// Attempt time.
    pub now_ms: i64,
}

/// A recall query.
#[derive(Clone, Debug)]
pub struct RecallRequest {
    /// Query text (drives the lexical branch).
    pub query_text: String,
    /// Caller-provided embedding of the query (drives the semantic
    /// branch), unit-normalised floats.
    pub embedding: Vec<f32>,
    /// Maximum results wanted.
    pub limit: usize,
    /// Explicit PAD state override. `None` uses the engine's own
    /// durable limbic state (decayed to `now_ms`), which is the normal
    /// mode; an override supports per-request states, e.g. one state
    /// per conversation.
    pub current_state: Option<Pad>,
    /// Current time, Unix milliseconds. Explicit for determinism.
    pub now_ms: i64,
    /// Mandatory identity boundary. Local scope is used when absent.
    pub scope: Option<RecallScope>,
    /// Space that produced the query embedding. Engine default is used when absent.
    pub embedding_space: Option<EmbeddingSpaceIdentity>,
    /// Authority used to derive the disclosed view.
    pub disclosure_authority: celiums_cognition::DisclosureAuthority,
    /// Purpose used to derive the disclosed view.
    pub disclosure_purpose: MemoryPurpose,
}

/// One recalled memory with its full score breakdown — glass-box
/// scoring in the spirit of Hyphae's `HybridExplanation`.
#[derive(Clone, Debug)]
pub struct ScoredMemory {
    /// The recalled memory.
    pub memory: Memory,
    /// Per-channel scores that produced `final_score`.
    pub channels: ChannelScores,
    /// Final cognitive score.
    pub final_score: f64,
    /// Policy-safe content view; raw content remains internal to `memory`.
    pub disclosed_content: Option<String>,
    /// Disclosure decision applied to this result.
    pub disclosure: celiums_cognition::DisclosureClass,
}

/// Why one retrieval branch produced no candidates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BranchAbstention {
    /// The branch had no candidates at all.
    NoCandidates,
    /// Best semantic score was below the candidate threshold.
    BelowThreshold,
    /// Semantic best/runner-up margin was ambiguous.
    Ambiguous,
}

/// Complete recall response with preserved branch evidence.
#[derive(Clone, Debug)]
pub struct RecallResponse {
    /// Ranked memories above the score threshold.
    pub results: Vec<ScoredMemory>,
    /// Lexical branch abstention, when it produced nothing.
    pub lexical_abstention: Option<BranchAbstention>,
    /// Semantic branch abstention, when it produced nothing.
    pub semantic_abstention: Option<BranchAbstention>,
}

/// Recall request augmented with bounded graph candidate generation.
#[derive(Clone, Debug)]
pub struct GraphRecallRequest {
    /// Standard hybrid recall request.
    pub recall: RecallRequest,
    /// Graph depth budget.
    pub max_depth: usize,
    /// Graph edge budget.
    pub max_edges: usize,
    /// Graph entity budget.
    pub max_entities: usize,
    /// Graph-derived memory candidate budget.
    pub max_memories: usize,
}

/// One graph-assisted recalled memory with path evidence.
#[derive(Clone, Debug)]
pub struct GraphScoredMemory {
    /// Recalled memory.
    pub memory: Memory,
    /// Standard cognitive channels.
    pub channels: ChannelScores,
    /// Final score with a transparent graph candidate floor.
    pub final_score: f64,
    /// Explicit graph-path score (`1 / path length`), zero for direct candidates.
    pub graph_score: f64,
    /// Policy-safe content.
    pub disclosed_content: Option<String>,
    /// Disclosure decision.
    pub disclosure: celiums_cognition::DisclosureClass,
    /// Entity IDs explaining graph retrieval; empty for direct candidates.
    pub graph_path: Vec<EntityId>,
}

/// Complete graph-assisted recall response.
#[derive(Clone, Debug)]
pub struct GraphRecallResponse {
    /// Ranked results.
    pub results: Vec<GraphScoredMemory>,
    /// Whether graph generation truncated.
    pub graph_truncated: bool,
    /// Graph truncation reason.
    pub graph_truncation_reason: Option<GraphTruncationReason>,
    /// Visible edges inspected.
    pub graph_inspected_edges: usize,
}

/// Policy-safe entity lookup result.
#[derive(Clone, Debug)]
pub struct EntityMemoryView {
    /// Visible memory metadata.
    pub memory: Memory,
    /// Governed content view.
    pub disclosed_content: Option<String>,
    /// Disclosure decision.
    pub disclosure: celiums_cognition::DisclosureClass,
}

/// Scoped request to list durable memories without reactivation.
#[derive(Clone, Debug)]
pub struct ListMemoriesRequest {
    /// Non-bypassable authorization scope.
    pub scope: RecallScope,
    /// Optional canonical caller filter.
    pub filter: Option<MemoryFilter>,
    /// Page size, clamped to 1..=200.
    pub limit: usize,
}

/// One page of durable memories.
#[derive(Clone, Debug)]
pub struct MemoryPage {
    /// Visible memories ordered newest first.
    pub memories: Vec<Memory>,
    /// Total visible matches before page truncation.
    pub matched: u64,
}

/// Mutable fields supported by the P1 memory API.
#[derive(Clone, Debug, Default)]
pub struct MemoryPatch {
    /// Replace importance, clamped to `[0, 1]`.
    pub importance: Option<f64>,
    /// Replace lifecycle state.
    pub state: Option<MemoryState>,
    /// Replace visibility scope, subject to identity invariants.
    pub scope: Option<Scope>,
    /// Replace all tags.
    pub tags: Option<Vec<String>>,
    /// Replace or clear event time; outer option means field supplied.
    pub event_at_ms: Option<Option<i64>>,
}

/// Scoped optimistic update request.
#[derive(Clone, Debug)]
pub struct UpdateMemoryRequest {
    /// Memory ID.
    pub id: String,
    /// Non-bypassable authorization scope.
    pub scope: RecallScope,
    /// Mutable fields.
    pub patch: MemoryPatch,
    /// Required current revision.
    pub if_revision: u64,
    /// Update time.
    pub now_ms: i64,
}

/// Result of one hard-delete request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeleteMemoryOutcome {
    /// Memory ID requested.
    pub id: String,
    /// Whether a visible memory existed and was removed.
    pub deleted: bool,
}

/// One per-item outcome in an independent remember batch.
#[derive(Debug)]
pub struct BatchRememberOutcome {
    /// Input index.
    pub index: usize,
    /// Successful memory or typed error text.
    pub result: Result<Memory, String>,
}

/// Result of evaluating a proposed action without executing it.
#[derive(Clone, Debug)]
pub struct ActionDecision {
    /// Whether policy permits the proposed action.
    pub allowed: bool,
    /// Full deterministic governance classification.
    pub governance: celiums_cognition::GovernanceClassification,
    /// Durable audit entry recording the decision.
    pub audit: EthicsAuditEntry,
}

/// Circadian telemetry: what time the engine thinks it is for the
/// user, and why.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CircadianStatus {
    /// Effective UTC offset in minutes.
    pub offset_minutes: i32,
    /// Provenance: `override`, `behavior`, or `utc-fallback`.
    pub source: &'static str,
    /// Local hour under the effective offset.
    pub local_hour: f64,
    /// Semantic day phase (morning-peak, night-rest…).
    pub time_of_day: &'static str,
    /// Factor accumulators, decayed to now.
    pub factors: celiums_cognition::CircadianFactors,
    /// The behaviour-inferred rhythm.
    pub rhythm: ActivityRhythm,
}

/// Outcome of one consolidation pass.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ConsolidationReport {
    /// New memories created.
    pub created: u64,
    /// Lines merged into existing duplicates.
    pub merged: u64,
    /// Lines below the noise or importance floor.
    pub skipped: u64,
}

/// Outcome of one lifecycle pass.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LifecycleReport {
    /// Memories whose importance decayed.
    pub decayed: u64,
    /// Memories archived (importance below the threshold).
    pub archived: u64,
}

/// A request to write one journal entry.
#[derive(Clone, Debug)]
pub struct JournalWriteRequest {
    /// Owning agent (P0 §3.1: mandatory, validated, never defaulted).
    pub agent_id: String,
    /// Entry taxonomy.
    pub entry_type: JournalEntryType,
    /// First-person entry text.
    pub content: String,
    /// Causal predecessors (entry ids of this agent).
    pub preceded_by: Vec<String>,
    /// Honest valence in `[-1, 1]`.
    pub valence: Option<f64>,
    /// Short justification for the valence (clamped to 500 chars).
    pub valence_reason: Option<String>,
    /// Free-form tags.
    pub tags: Vec<String>,
    /// Stable per-conversation grouping key.
    pub conversation_id: Option<String>,
    /// Write time, Unix milliseconds. Explicit for determinism.
    pub now_ms: i64,
}

/// A journal recall query (lexical over one agent's entries).
#[derive(Clone, Debug)]
pub struct JournalRecallRequest {
    /// Owning agent.
    pub agent_id: String,
    /// Query text; empty returns the most recent entries.
    pub query: String,
    /// Filter to one entry type.
    pub entry_type: Option<JournalEntryType>,
    /// Maximum entries returned.
    pub limit: usize,
    /// Whether superseded entries are included (TS default: excluded).
    pub include_superseded: bool,
}

/// Candidate keys with their branch scores, plus the branch's
/// abstention when it produced nothing.
type BranchCandidates = (Vec<(Vec<u8>, f64)>, Option<BranchAbstention>);

/// Durable cognitive memory engine over Hyphae.
///
/// The engine carries its own limbic (PAD) state, persisted in the
/// same durable store as the memories: no cache service holds it, and
/// `&mut self` serialises updates — the role the Valkey distributed
/// mutex played in the TypeScript engine.
pub struct MemoryEngine {
    hyphae: HyphaeEngine,
    tenant_id: TenantId,
    dimension: u16,
    embedding_space: EmbeddingSpaceIdentity,
    config: RecallConfig,
    limbic_config: LimbicConfig,
    affect: AffectState,
    circadian_config: CircadianConfig,
    factor_weights: FactorWeights,
    circadian: CircadianState,
}

impl MemoryEngine {
    /// Opens (or creates) a memory engine at `path` with a fixed
    /// embedding `dimension`.
    ///
    /// Space and index definitions are idempotent: reopening with the
    /// same dimension succeeds, reopening with a different one fails
    /// loudly — the dimension guard that keeps recall from silently
    /// degrading.
    ///
    /// # Errors
    ///
    /// Fails when the data directory cannot be opened or when the
    /// stored definitions conflict with `dimension`.
    pub fn open(
        path: impl AsRef<Path>,
        dimension: u16,
        config: RecallConfig,
    ) -> Result<Self, MemoryEngineError> {
        Self::open_for_tenant_with_embedding(
            path,
            config,
            TenantId::new("local").expect("static identity"),
            EmbeddingSpaceIdentity::deterministic(dimension),
        )
    }

    /// Opens a memory engine physically bound to one tenant.
    ///
    /// # Errors
    ///
    /// Fails when the data directory or stored definitions are invalid.
    pub fn open_for_tenant(
        path: impl AsRef<Path>,
        dimension: u16,
        config: RecallConfig,
        tenant_id: TenantId,
    ) -> Result<Self, MemoryEngineError> {
        Self::open_for_tenant_with_embedding(
            path,
            config,
            tenant_id,
            EmbeddingSpaceIdentity::deterministic(dimension),
        )
    }

    /// Opens an engine bound to one tenant and one immutable embedding space.
    ///
    /// # Errors
    ///
    /// Fails when the stored embedding identity differs in any component.
    pub fn open_for_tenant_with_embedding(
        path: impl AsRef<Path>,
        config: RecallConfig,
        tenant_id: TenantId,
        embedding_space: EmbeddingSpaceIdentity,
    ) -> Result<Self, MemoryEngineError> {
        let dimension = embedding_space.dimension;
        let opened = HyphaeEngine::open(path)?;
        let mut hyphae = opened.engine;
        match hyphae.get_record(EMBEDDING_SPACE_KEY)? {
            Some(record) => {
                let stored = EmbeddingSpaceIdentity::from_record(&record)?;
                ensure_embedding_space(&stored, &embedding_space)?;
            }
            None => {
                hyphae.put_record(Uuid::now_v7(), &embedding_space.to_record())?;
            }
        }
        let space = VectorSpaceDefinition::cosine(memory_space(), dimension)?;
        hyphae.define_vector_space(Uuid::now_v7(), space)?;
        let index = LexicalIndexDefinition::new(
            content_index(),
            vec![LexicalField {
                path: FieldPath::field("content"),
                weight_micros: 1_000_000,
            }],
        )
        .map_err(HyphaeError::from)?;
        hyphae.define_lexical_index(Uuid::now_v7(), index)?;

        let limbic_config = LimbicConfig::default();
        let affect = match hyphae.get_record(AFFECT_STATE_KEY)? {
            Some(record) => AffectState::from_record(&record)?,
            None => AffectState {
                pad: limbic_config.homeostatic,
                updated_at_ms: 0,
            },
        };
        // The circadian state survives restarts: rhythm continuity is
        // the point. A fresh engine starts neutral (no override).
        let circadian = match hyphae.get_record(CIRCADIAN_STATE_KEY)? {
            Some(record) => CircadianState::from_record(&record)?,
            None => CircadianState::new(None),
        };
        migrate_legacy_memories(&mut hyphae, &tenant_id, &embedding_space)?;
        Ok(Self {
            hyphae,
            tenant_id,
            dimension,
            embedding_space,
            config,
            limbic_config,
            affect,
            circadian_config: CircadianConfig::default(),
            factor_weights: FactorWeights::default(),
            circadian,
        })
    }

    /// Tenant physically bound to this engine instance.
    pub fn tenant_id(&self) -> &TenantId {
        &self.tenant_id
    }

    /// Embedding space physically bound to this engine.
    pub fn embedding_space(&self) -> &EmbeddingSpaceIdentity {
        &self.embedding_space
    }

    /// Sets (or clears) the explicit timezone override, persisting it.
    /// An explicit offset always wins over the inferred rhythm.
    ///
    /// # Errors
    ///
    /// Fails on storage failure.
    pub fn set_timezone_override(
        &mut self,
        offset_minutes: Option<i32>,
        now_ms: i64,
    ) -> Result<(), MemoryEngineError> {
        self.circadian.timezone_override_minutes = offset_minutes;
        self.persist_circadian(now_ms)
    }

    /// The effective UTC offset in minutes, with its provenance:
    /// explicit override wins, then the behaviour-inferred rhythm
    /// (when confident), then UTC.
    pub fn effective_timezone(&self) -> (i32, &'static str) {
        if let Some(minutes) = self.circadian.timezone_override_minutes {
            return (minutes, "override");
        }
        let rhythm = self.activity_rhythm();
        match rhythm.offset_minutes {
            // Below this confidence the trough is noise, not schedule.
            Some(minutes) if rhythm.confidence >= 0.3 => (minutes, "behavior"),
            _ => (0, "utc-fallback"),
        }
    }

    /// The behaviour-inferred activity rhythm (VPN-immune tz signal).
    pub fn activity_rhythm(&self) -> ActivityRhythm {
        infer_activity_rhythm(&self.circadian.activity_histogram)
    }

    /// Current limbic (PAD) state after homeostatic decay to `now_ms`,
    /// modulated by the circadian rhythm.
    ///
    /// Fresh-on-read on both layers: the limbic snapshot decays by the
    /// elapsed time AND the circadian factors are viewed decayed —
    /// caffeine from five hours ago is half gone even if no event
    /// fired since. The rhythm runs on the user's effective local hour
    /// (override > inferred behaviour > UTC), not raw UTC.
    pub fn affect_state(&self, now_ms: i64) -> Pad {
        let decayed = limbic::decay(
            self.affect.pad,
            &self.limbic_config,
            minutes_between(self.affect.updated_at_ms, now_ms),
        );
        let inactive = self.inactive_hours(now_ms);
        let stale_minutes = minutes_between(self.circadian.updated_at_ms, now_ms);
        let factors = self.circadian.factors.decayed(stale_minutes, inactive);
        circadian::modify_homeostatic(
            decayed,
            &self.circadian_config,
            &self.factor_weights,
            &factors,
            self.local_hour(now_ms),
            inactive,
        )
    }

    /// Feeds one circadian event (task completed, error, caffeine…)
    /// into the rhythm: decays factors by the elapsed time, applies
    /// the event, bumps the activity histogram (real interaction =
    /// behavioural tz signal), and persists the state durably.
    ///
    /// # Errors
    ///
    /// Fails on storage failure.
    pub fn record_circadian_event(
        &mut self,
        event: CircadianEvent,
        now_ms: i64,
    ) -> Result<(), MemoryEngineError> {
        let inactive = self.inactive_hours(now_ms);
        let stale_minutes = minutes_between(self.circadian.updated_at_ms, now_ms);
        self.circadian.factors.decay(stale_minutes, inactive);
        self.circadian.factors.record_event(event);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let bucket = (utc_hour(now_ms) as usize).min(23);
        self.circadian.activity_histogram[bucket] =
            self.circadian.activity_histogram[bucket].saturating_add(1);
        self.circadian.last_interaction_ms = now_ms;
        self.persist_circadian(now_ms)
    }

    /// Full circadian telemetry: effective timezone with provenance,
    /// local hour, day phase, decayed factors, inferred rhythm.
    pub fn circadian_status(&self, now_ms: i64) -> CircadianStatus {
        let (offset_minutes, source) = self.effective_timezone();
        let local_hour = self.local_hour(now_ms);
        let inactive = self.inactive_hours(now_ms);
        CircadianStatus {
            offset_minutes,
            source,
            local_hour,
            time_of_day: celiums_cognition::classify_time_of_day(local_hour),
            factors: self.circadian.factors.decayed(
                minutes_between(self.circadian.updated_at_ms, now_ms),
                inactive,
            ),
            rhythm: self.activity_rhythm(),
        }
    }

    /// Local hour under the effective timezone.
    fn local_hour(&self, now_ms: i64) -> f64 {
        let (offset_minutes, _source) = self.effective_timezone();
        (utc_hour(now_ms) + f64::from(offset_minutes) / 60.0).rem_euclid(24.0)
    }

    fn persist_circadian(&mut self, now_ms: i64) -> Result<(), MemoryEngineError> {
        self.circadian.updated_at_ms = now_ms;
        self.hyphae
            .put_record(Uuid::now_v7(), &self.circadian.to_record())?;
        Ok(())
    }

    /// Hours since the last interaction; a fresh engine (no
    /// interaction recorded) counts as just-constructed, not as idle
    /// since 1970 — the TS constructor semantics.
    fn inactive_hours(&self, now_ms: i64) -> f64 {
        if self.circadian.last_interaction_ms == 0 {
            0.0
        } else {
            hours_between(self.circadian.last_interaction_ms, now_ms)
        }
    }

    /// Durably accounts for one raw source event and materializes it when an
    /// embedding is available. Identical retries reuse the same event and
    /// memory IDs; conflicting retries are recorded and rejected.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, conflicting source identity, malformed
    /// durable state, or storage/materialization failure.
    pub fn ingest_event(
        &mut self,
        request: IngestEventRequest,
    ) -> Result<IngestionEntry, MemoryEngineError> {
        self.require_tenant(&request.identity.tenant_id)?;
        let event_id = EventId::derive(
            &self.tenant_id,
            &request.source_namespace,
            &request.source_event_id,
        );
        let request_hash = canonical_ingest_event_hash(&request);
        let mut entry = self.prepare_ingestion_entry(&request, event_id, request_hash)?;

        let Some(embedding) = request.embedding else {
            return Ok(entry);
        };
        if !matches!(
            entry.status,
            IngestionStatus::Received | IngestionStatus::Failed
        ) {
            return Ok(entry);
        }
        let mut provenance = crate::Provenance::observed(
            request.source_kind,
            &request.content,
            Some(request.source_event_id.to_string()),
            request.source_uri,
            request.actor,
        );
        provenance.source_namespace = Some(request.source_namespace.to_string());
        provenance.event_id = Some(entry.event_id.to_string());
        provenance.turn_id = request.turn_id.map(|turn_id| turn_id.to_string());
        let remember = RememberRequest {
            content: request.content,
            embedding,
            tags: request.tags,
            scope: request.scope,
            importance: request.importance,
            now_ms: request.ingested_at_ms,
            context: Some(RememberContext {
                identity: request.identity,
                provenance,
                event_at_ms: request.event_at_ms,
                ingested_at_ms: request.ingested_at_ms,
            }),
            embedding_space: request.embedding_space,
            idempotency_key: Some(
                IdempotencyKey::new(format!("ingestion:{}", entry.event_id))
                    .expect("event UUID yields a valid idempotency key"),
            ),
            content_role: request.content_role,
            purpose: request.purpose,
        };
        match self.remember(remember) {
            Ok(memory) => {
                entry.status = IngestionStatus::Materialized;
                entry.memory_id = Some(memory.id);
            }
            Err(MemoryEngineError::EthicsBlocked { .. }) => {
                entry.status = IngestionStatus::Rejected;
                entry.error_code = Some("ethics_blocked".to_owned());
            }
            Err(error) => {
                entry.status = IngestionStatus::Failed;
                entry.error_code = Some(ingestion_error_code(&error).to_owned());
                self.persist_ingestion(&entry)?;
                return Err(error);
            }
        }
        self.persist_ingestion(&entry)?;
        Ok(entry)
    }

    fn prepare_ingestion_entry(
        &mut self,
        request: &IngestEventRequest,
        event_id: EventId,
        request_hash: String,
    ) -> Result<IngestionEntry, MemoryEngineError> {
        if let Some(mut entry) = self.get_ingestion_unscoped(&event_id)? {
            entry.attempt_count = entry.attempt_count.saturating_add(1);
            entry.last_attempted_at_ms = request.ingested_at_ms;
            if entry.request_hash != request_hash {
                entry.conflict_count = entry.conflict_count.saturating_add(1);
                self.persist_ingestion(&entry)?;
                return Err(MemoryEngineError::IngestionConflict {
                    event_id: event_id.to_string(),
                });
            }
            self.persist_ingestion(&entry)?;
            return Ok(entry);
        }

        let entry = new_ingestion_entry(request, event_id, request_hash);
        self.persist_ingestion(&entry)?;
        Ok(entry)
    }

    /// Gets one durable ingestion entry by stable event ID.
    ///
    /// # Errors
    ///
    /// Fails on storage or durable decode failure.
    pub fn get_ingestion(
        &self,
        event_id: &EventId,
        scope: &RecallScope,
    ) -> Result<Option<IngestionEntry>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        Ok(self
            .get_ingestion_unscoped(event_id)?
            .filter(|entry| ingestion_visible_to(entry, scope)))
    }

    /// Lists visible ingestion entries in deterministic event-ID order.
    ///
    /// # Errors
    ///
    /// Fails on query or durable decode failure.
    pub fn ingestion_entries(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<IngestionEntry>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let entries = self
            .scan_prefix(IngestionEntry::prefix())?
            .iter()
            .map(|record| IngestionEntry::from_record(record).map_err(Into::into))
            .collect::<Result<Vec<_>, MemoryEngineError>>()?;
        Ok(entries
            .into_iter()
            .filter(|entry| ingestion_visible_to(entry, scope))
            .collect())
    }

    /// Counts every visible event by its mutually exclusive durable status.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, query, or durable decode failure.
    pub fn ingestion_coverage(
        &self,
        scope: &RecallScope,
    ) -> Result<IngestionCoverage, MemoryEngineError> {
        let entries = self.ingestion_entries(scope)?;
        let mut coverage = IngestionCoverage {
            attempted: entries.len() as u64,
            ..IngestionCoverage::default()
        };
        for entry in entries {
            match entry.status {
                IngestionStatus::Received => coverage.received += 1,
                IngestionStatus::Materialized => coverage.materialized += 1,
                IngestionStatus::Rejected => coverage.rejected += 1,
                IngestionStatus::Failed => coverage.failed += 1,
            }
        }
        Ok(coverage)
    }

    fn get_ingestion_unscoped(
        &self,
        event_id: &EventId,
    ) -> Result<Option<IngestionEntry>, MemoryEngineError> {
        self.hyphae
            .get_record(&IngestionEntry::durable_key(event_id))?
            .as_ref()
            .map(IngestionEntry::from_record)
            .transpose()
            .map_err(Into::into)
    }

    fn persist_ingestion(&mut self, entry: &IngestionEntry) -> Result<(), MemoryEngineError> {
        self.hyphae
            .put_record(deterministic_ingestion_uuid(entry), &entry.to_record())?;
        Ok(())
    }

    /// Records a provider failure without losing or changing the raw event.
    ///
    /// # Errors
    ///
    /// Fails on tenant/scope mismatch, missing event, or storage failure.
    pub fn record_enrichment_failure(
        &mut self,
        event_id: &EventId,
        scope: &RecallScope,
        provider: &str,
        error_code: &str,
        now_ms: i64,
    ) -> Result<IngestionEntry, MemoryEngineError> {
        let mut entry = self.get_ingestion(event_id, scope)?.ok_or_else(|| {
            MemoryEngineError::IngestionEventNotFound {
                event_id: event_id.to_string(),
            }
        })?;
        if entry.status.is_terminal() {
            return Ok(entry);
        }
        entry.status = IngestionStatus::Failed;
        entry.error_code = Some(error_code.to_owned());
        entry.enrichment_provider = Some(provider.to_owned());
        entry.enrichment_attempt_count = entry.enrichment_attempt_count.saturating_add(1);
        entry.last_attempted_at_ms = now_ms;
        self.persist_ingestion(&entry)?;
        Ok(entry)
    }

    /// Resumes one raw event with provider enrichment.
    ///
    /// # Errors
    ///
    /// Fails on scope, provider output, governance, or storage failure. The raw
    /// event remains durable and retryable after any provider/materialization failure.
    pub fn enrich_event(
        &mut self,
        request: EnrichEventRequest,
    ) -> Result<IngestionEntry, MemoryEngineError> {
        let mut entry = self
            .get_ingestion(&request.event_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::IngestionEventNotFound {
                event_id: request.event_id.to_string(),
            })?;
        if entry.status.is_terminal() {
            return Ok(entry);
        }
        entry.enrichment_provider = Some(request.provider);
        entry.enrichment_attempt_count = entry.enrichment_attempt_count.saturating_add(1);
        entry.last_attempted_at_ms = request.now_ms;
        self.persist_ingestion(&entry)?;

        let result = self.materialize_ingestion_entry(
            &entry,
            request.embedding,
            request.embedding_space,
            request.now_ms,
        );
        match result {
            Ok(memory) => {
                entry.status = IngestionStatus::Materialized;
                entry.memory_id = Some(memory.id);
                entry.error_code = None;
                self.persist_ingestion(&entry)?;
                Ok(entry)
            }
            Err(error) => {
                entry.status = IngestionStatus::Failed;
                entry.error_code = Some(ingestion_error_code(&error).to_owned());
                self.persist_ingestion(&entry)?;
                Err(error)
            }
        }
    }

    fn materialize_ingestion_entry(
        &mut self,
        entry: &IngestionEntry,
        embedding: Vec<f32>,
        embedding_space: Option<EmbeddingSpaceIdentity>,
        now_ms: i64,
    ) -> Result<Memory, MemoryEngineError> {
        let mut provenance = crate::Provenance::observed(
            entry.source_kind,
            &entry.content,
            Some(entry.source_event_id.to_string()),
            entry.source_uri.clone(),
            entry.actor.clone(),
        );
        provenance.source_namespace = Some(entry.source_namespace.to_string());
        provenance.event_id = Some(entry.event_id.to_string());
        provenance.turn_id = entry.turn_id.as_ref().map(ToString::to_string);
        self.remember(RememberRequest {
            content: entry.content.clone(),
            embedding,
            tags: entry.tags.clone(),
            scope: entry.scope,
            importance: entry.importance(),
            now_ms,
            context: Some(RememberContext {
                identity: entry.identity.clone(),
                provenance,
                event_at_ms: entry.event_at_ms,
                ingested_at_ms: entry.first_ingested_at_ms,
            }),
            embedding_space,
            idempotency_key: Some(
                IdempotencyKey::new(format!("ingestion:{}", entry.event_id))
                    .expect("event UUID yields a valid idempotency key"),
            ),
            content_role: entry.content_role,
            purpose: entry.purpose,
        })
    }

    /// Ingests a conversation after validating that every event belongs to it.
    ///
    /// # Errors
    ///
    /// Fails before writing when any event has a different conversation ID.
    pub fn ingest_conversation(
        &mut self,
        request: IngestConversationRequest,
    ) -> Result<IngestionBatch, MemoryEngineError> {
        for (index, event) in request.batch.events.iter().enumerate() {
            if event.identity.conversation_id.as_ref() != Some(&request.conversation_id) {
                return Err(MemoryEngineError::ConversationMismatch { index });
            }
        }
        self.ingest_batch(request.batch)
    }

    /// Processes every event independently and persists a resumable batch job.
    ///
    /// # Errors
    ///
    /// Fails on empty batches, mixed ownership, changed membership, or storage.
    /// Individual event materialization failures are returned in `items`.
    pub fn ingest_batch(
        &mut self,
        request: IngestBatchRequest,
    ) -> Result<IngestionBatch, MemoryEngineError> {
        let scope = batch_scope(&request.events)?;
        self.require_tenant(&scope.tenant_id)?;
        let request_hash = canonical_batch_hash(&request.events);
        let existing = self.get_ingestion_batch_unscoped(&request.batch_id)?;
        if existing
            .as_ref()
            .is_some_and(|batch| batch.request_hash != request_hash)
        {
            return Err(MemoryEngineError::IngestionBatchConflict {
                batch_id: request.batch_id.to_string(),
            });
        }

        if existing.is_none() && request.events.iter().all(|event| event.embedding.is_none()) {
            return self.ingest_raw_batch(request, scope, request_hash);
        }

        let mut items = Vec::with_capacity(request.events.len());
        for (index, event) in request.events.into_iter().enumerate() {
            let event_id = EventId::derive(
                &self.tenant_id,
                &event.source_namespace,
                &event.source_event_id,
            );
            let entry = match self.ingest_event(event) {
                Ok(entry) => entry,
                Err(error) => self.get_ingestion_unscoped(&event_id)?.ok_or(error)?,
            };
            let mut outcome = BatchItemOutcome::from(&entry);
            outcome.index = index;
            items.push(outcome);
        }

        let batch = existing.map_or_else(
            || {
                IngestionBatch::new(
                    request.batch_id,
                    request_hash,
                    scope,
                    request.now_ms,
                    items.clone(),
                )
            },
            |mut batch| {
                batch.resume(request.now_ms, items.clone());
                batch
            },
        );
        self.persist_ingestion_batch(&batch)?;
        Ok(batch)
    }

    fn ingest_raw_batch(
        &mut self,
        request: IngestBatchRequest,
        scope: RecallScope,
        request_hash: String,
    ) -> Result<IngestionBatch, MemoryEngineError> {
        let entries: Vec<IngestionEntry> = request
            .events
            .iter()
            .map(|event| {
                let event_id = EventId::derive(
                    &self.tenant_id,
                    &event.source_namespace,
                    &event.source_event_id,
                );
                new_ingestion_entry(event, event_id, canonical_ingest_event_hash(event))
            })
            .collect();
        let items = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let mut item = BatchItemOutcome::from(entry);
                item.index = index;
                item
            })
            .collect();
        let batch =
            IngestionBatch::new(request.batch_id, request_hash, scope, request.now_ms, items);
        let mut records: Vec<hyphae_query::Record> =
            entries.iter().map(IngestionEntry::to_record).collect();
        records.push(batch.to_record());
        self.hyphae.put_records(Uuid::now_v7(), &records)?;
        Ok(batch)
    }

    /// Gets one visible durable ingestion batch.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, storage, or durable decode failure.
    pub fn get_ingestion_batch(
        &self,
        batch_id: &BatchId,
        scope: &RecallScope,
    ) -> Result<Option<IngestionBatch>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        Ok(self
            .get_ingestion_batch_unscoped(batch_id)?
            .filter(|batch| recall_scope_visible_to(&batch.scope, scope)))
    }

    fn get_ingestion_batch_unscoped(
        &self,
        batch_id: &BatchId,
    ) -> Result<Option<IngestionBatch>, MemoryEngineError> {
        self.hyphae
            .get_record(&IngestionBatch::durable_key(&self.tenant_id, batch_id))?
            .as_ref()
            .map(IngestionBatch::from_record)
            .transpose()
            .map_err(Into::into)
    }

    fn persist_ingestion_batch(&mut self, batch: &IngestionBatch) -> Result<(), MemoryEngineError> {
        self.hyphae.put_record(Uuid::now_v7(), &batch.to_record())?;
        Ok(())
    }

    /// Creates one atomic claim and its evidence links without mutating source episodes.
    ///
    /// # Errors
    ///
    /// Fails on invalid claim shape, scope/tenant mismatch, missing evidence, or storage.
    pub fn create_claim(
        &mut self,
        request: CreateClaimRequest,
    ) -> Result<Claim, MemoryEngineError> {
        request.validate()?;
        self.require_tenant(&request.scope.tenant_id)?;
        for evidence in &request.evidence {
            if self.is_derived_source_forgotten(&evidence.event_id, &request.scope)? {
                return Err(MemoryEngineError::ClaimEvidenceNotFound {
                    event_id: evidence.event_id.to_string(),
                });
            }
            let episode = self
                .get_ingestion(&evidence.event_id, &request.scope)?
                .ok_or_else(|| MemoryEngineError::ClaimEvidenceNotFound {
                    event_id: evidence.event_id.to_string(),
                })?;
            if evidence
                .excerpt
                .as_ref()
                .is_some_and(|excerpt| !episode.content.contains(excerpt))
            {
                return Err(MemoryEngineError::ClaimEvidenceExcerptMismatch {
                    event_id: evidence.event_id.to_string(),
                });
            }
        }

        let claim = Claim::from_request(&request);
        if let Some(existing) = self.get_claim(&claim.id, &request.scope)? {
            if existing != claim {
                return Err(MemoryEngineError::ClaimConflict {
                    claim_id: claim.id.to_string(),
                });
            }
            return Ok(existing);
        }
        let mut records = Vec::with_capacity(request.evidence.len() + 1);
        records.push(claim.to_record());
        records.extend(request.evidence.iter().map(|evidence| {
            ClaimEvidence::from_input(claim.id.clone(), evidence, request.recorded_at_ms)
                .to_record()
        }));
        self.hyphae
            .put_records(deterministic_claim_uuid(&claim.id, "create"), &records)?;
        Ok(claim)
    }

    /// Gets one visible claim by ID.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, storage, or decode failure.
    pub fn get_claim(
        &self,
        claim_id: &ClaimId,
        scope: &RecallScope,
    ) -> Result<Option<Claim>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let Some(record) = self.hyphae.get_record(&Claim::key(claim_id))? else {
            return Ok(None);
        };
        let claim = Claim::from_record(&record)?;
        Ok(claim_visible_to(&claim, scope).then_some(claim))
    }

    /// Lists visible immutable evidence links for one claim.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, storage, or decode failure.
    pub fn claim_evidence(
        &self,
        claim_id: &ClaimId,
        scope: &RecallScope,
    ) -> Result<Vec<ClaimEvidence>, MemoryEngineError> {
        if self.get_claim(claim_id, scope)?.is_none() {
            return Ok(Vec::new());
        }
        self.scan_prefix(&ClaimEvidence::prefix(claim_id))?
            .iter()
            .map(|record| ClaimEvidence::from_record(record).map_err(Into::into))
            .collect()
    }

    fn active_claim_evidence(
        &self,
        claim_id: &ClaimId,
        scope: &RecallScope,
    ) -> Result<Vec<ClaimEvidence>, MemoryEngineError> {
        let mut active = Vec::new();
        for evidence in self.claim_evidence(claim_id, scope)? {
            if !self.is_derived_source_forgotten(&evidence.event_id, scope)? {
                active.push(evidence);
            }
        }
        Ok(active)
    }

    /// Appends a validated claim supersession relation.
    ///
    /// # Errors
    ///
    /// Fails on missing claims, property mismatch, invalid successor shape,
    /// cycles, tenant mismatch, or storage failure.
    pub fn supersede_claim(
        &mut self,
        request: SupersedeClaimRequest,
    ) -> Result<ClaimSupersession, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        let original = self
            .get_claim(&request.original_claim_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::ClaimNotFound {
                claim_id: request.original_claim_id.to_string(),
            })?;
        let successor = request
            .successor_claim_id
            .as_ref()
            .map(|id| self.get_claim(id, &request.scope))
            .transpose()?
            .flatten();
        if request.relation != ClaimSupersessionRelation::Recants && successor.is_none() {
            return Err(MemoryEngineError::ClaimSuccessorRequired);
        }
        if let Some(successor) = &successor {
            if original.subject != successor.subject || original.predicate != successor.predicate {
                return Err(MemoryEngineError::ClaimPropertyMismatch);
            }
            if self.claim_reaches(&successor.id, &original.id, &request.scope)? {
                return Err(MemoryEngineError::ClaimSupersessionCycle);
            }
        }

        let link = ClaimSupersession::from_request(&request);
        let key = format!("__celiums/claim_supersession/{}", link.id).into_bytes();
        if let Some(record) = self.hyphae.get_record(&key)? {
            return Ok(ClaimSupersession::from_record(&record)?);
        }
        self.hyphae.put_record(
            deterministic_claim_uuid(&request.original_claim_id, &link.id),
            &link.to_record(),
        )?;
        Ok(link)
    }

    /// Lists visible append-only claim supersession links.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, query, claim lookup, or decode failure.
    pub fn claim_supersessions(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<ClaimSupersession>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let links = self
            .scan_prefix(ClaimSupersession::prefix())?
            .iter()
            .map(ClaimSupersession::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        let mut visible = Vec::new();
        for link in links {
            if self.get_claim(&link.original_claim_id, scope)?.is_some() {
                visible.push(link);
            }
        }
        Ok(visible)
    }

    /// Detects overlapping, incompatible values for the same visible property.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, query, or decode failure.
    pub fn claim_contradictions(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<ClaimContradiction>, MemoryEngineError> {
        let claims = self.visible_claims(scope)?;
        let mut contradictions = Vec::new();
        for (index, left) in claims.iter().enumerate() {
            for right in claims.iter().skip(index + 1) {
                if left.subject == right.subject
                    && left.predicate == right.predicate
                    && left.value != right.value
                    && let Some((overlap_from_ms, overlap_to_ms)) = validity_overlap(left, right)
                {
                    contradictions.push(ClaimContradiction {
                        left_claim_id: left.id.clone(),
                        right_claim_id: right.id.clone(),
                        kind: ClaimContradictionKind::OverlappingValueConflict,
                        overlap_from_ms,
                        overlap_to_ms,
                    });
                }
            }
        }
        Ok(contradictions)
    }

    /// Returns all claims for one property valid and known at the requested times.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, query, or durable decode failure.
    pub fn claims_at(&self, query: ClaimPropertyQuery) -> Result<Vec<Claim>, MemoryEngineError> {
        let mut claims: Vec<Claim> = self
            .visible_claims(&query.scope)?
            .into_iter()
            .filter(|claim| claim.subject == query.subject && claim.predicate == query.predicate)
            .filter(|claim| claim.recorded_at_ms <= query.known_at_ms)
            .filter(|claim| claim.valid_at(query.valid_at_ms))
            .collect();
        claims.sort_by(|left, right| {
            left.recorded_at_ms
                .cmp(&right.recorded_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(claims)
    }

    /// Returns current heads for one property, preserving all unresolved conflicts.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, query, or durable decode failure.
    pub fn latest_claims(
        &self,
        query: ClaimPropertyQuery,
    ) -> Result<Vec<Claim>, MemoryEngineError> {
        let links = self.claim_supersessions(&query.scope)?;
        let mut claims = self.claims_at(query.clone())?;
        claims.retain(|claim| {
            !links.iter().any(|link| {
                link.original_claim_id == claim.id
                    && link.relation.retires_original()
                    && link.effective_at_ms <= query.valid_at_ms
                    && link.recorded_at_ms <= query.known_at_ms
            })
        });
        Ok(claims)
    }

    /// Orders visible source events by source event time, falling back explicitly to ingestion.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, missing/hidden event, storage, or decode failure.
    pub fn event_sequence(
        &self,
        scope: &RecallScope,
        event_ids: &[EventId],
    ) -> Result<Vec<SequencedEvent>, MemoryEngineError> {
        let mut sequence = Vec::with_capacity(event_ids.len());
        for event_id in event_ids {
            let entry = self.get_ingestion(event_id, scope)?.ok_or_else(|| {
                MemoryEngineError::IngestionEventNotFound {
                    event_id: event_id.to_string(),
                }
            })?;
            let (effective_at_ms, basis) = entry.event_at_ms.map_or(
                (
                    entry.first_ingested_at_ms,
                    EventTimeBasis::IngestionFallback,
                ),
                |event_at_ms| (event_at_ms, EventTimeBasis::EventTime),
            );
            sequence.push(SequencedEvent {
                event_id: event_id.clone(),
                effective_at_ms,
                basis,
            });
        }
        sequence.sort_by(|left, right| {
            left.effective_at_ms
                .cmp(&right.effective_at_ms)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        Ok(sequence)
    }

    /// Captures semantic claim state and proof at one bitemporal query point.
    ///
    /// # Errors
    ///
    /// Fails on query, evidence lookup, storage, or decode failure.
    pub fn claim_snapshot(
        &self,
        query: ClaimPropertyQuery,
    ) -> Result<ClaimSnapshot, MemoryEngineError> {
        let claims = self.latest_claims(query.clone())?;
        let mut entries = Vec::with_capacity(claims.len());
        for claim in claims {
            let evidence = self.active_claim_evidence(&claim.id, &query.scope)?;
            entries.push(snapshot_entry(claim, &evidence));
        }
        Ok(ClaimSnapshot {
            valid_at_ms: query.valid_at_ms,
            known_at_ms: query.known_at_ms,
            entries,
        })
    }

    fn visible_claims(&self, scope: &RecallScope) -> Result<Vec<Claim>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let claims = self
            .scan_prefix(Claim::prefix())?
            .iter()
            .map(Claim::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        let mut visible = Vec::new();
        for claim in claims {
            if claim_visible_to(&claim, scope)
                && !self.active_claim_evidence(&claim.id, scope)?.is_empty()
            {
                visible.push(claim);
            }
        }
        Ok(visible)
    }

    fn claim_reaches(
        &self,
        start: &ClaimId,
        target: &ClaimId,
        scope: &RecallScope,
    ) -> Result<bool, MemoryEngineError> {
        let links = self.claim_supersessions(scope)?;
        let mut pending = vec![start.clone()];
        let mut visited = std::collections::BTreeSet::new();
        while let Some(current) = pending.pop() {
            if &current == target {
                return Ok(true);
            }
            if !visited.insert(current.clone()) {
                continue;
            }
            pending.extend(
                links
                    .iter()
                    .filter(|link| link.original_claim_id == current)
                    .filter_map(|link| link.successor_claim_id.clone()),
            );
        }
        Ok(false)
    }

    /// Stores one memory: classifies importance, affect and type from
    /// the content, then persists the document and its embedding.
    ///
    /// # Errors
    ///
    /// Fails on quantisation (including dimension mismatch) or storage
    /// failure. Nothing is stored when the embedding is invalid.
    pub fn remember(&mut self, request: RememberRequest) -> Result<Memory, MemoryEngineError> {
        // The ethics write-gate runs before anything is stored — the
        // TS incident lesson: gate on `enforcement_blocked`, never on
        // a mode-dependent `passed`. Blocked content never reaches the
        // log, the vectors or the entity index.
        let evaluation = evaluate_ethics(&request.content, None);
        let governance = classify_governance(
            &request.content,
            source_trust(request.context.as_ref()),
            request.content_role,
            request.purpose,
            request.now_ms,
            &evaluation,
        );
        if governance.enforcement == celiums_cognition::EnforcementDecision::Reject {
            let category = evaluation
                .layer_a
                .violations
                .first()
                .map(|violation| violation.category.as_str())
                .or_else(|| {
                    evaluation
                        .layer_b
                        .primary_risks
                        .first()
                        .map(|risk| risk.category.as_str())
                })
                .unwrap_or("catastrophic")
                .to_owned();
            return Err(MemoryEngineError::EthicsBlocked {
                category,
                violations: evaluation.layer_a.violations,
            });
        }

        let vector = quantize(&request.embedding, self.dimension)?;
        let requested_space = request
            .embedding_space
            .as_ref()
            .unwrap_or(&self.embedding_space);
        ensure_embedding_space(&self.embedding_space, requested_space)?;
        let context = request
            .context
            .unwrap_or_else(|| RememberContext::local(&request.content, request.now_ms));
        self.require_tenant(&context.identity.tenant_id)?;
        let expected_hash = blake3::hash(request.content.as_bytes())
            .to_hex()
            .to_string();
        if context.provenance.content_hash != expected_hash {
            return Err(MemoryEngineError::ContentHashMismatch);
        }

        let (classified_importance, _signals) = classify_importance(&request.content);
        let memory_id = request.idempotency_key.as_ref().map_or_else(
            || Uuid::now_v7().to_string(),
            |key| deterministic_remember_uuid(&self.tenant_id, key).to_string(),
        );
        let memory = Memory {
            id: memory_id,
            schema_version: 2,
            revision: 1,
            identity: context.identity,
            provenance: context.provenance,
            embedding_space: Some(self.embedding_space.clone()),
            governance: Some(MemoryGovernance(governance.clone())),
            importance: request
                .importance
                .map_or(classified_importance, |value| value.clamp(0.0, 1.0)),
            pad: extract_pad(&request.content),
            strength: 1.0,
            retrieval_count: 0,
            memory_type: classify_memory_type(&request.content),
            state: MemoryState::Active,
            scope: request.scope,
            tags: request.tags,
            entities: extract_entities(&request.content),
            consolidation_count: 0,
            created_at_ms: request.now_ms,
            updated_at_ms: request.now_ms,
            event_at_ms: context.event_at_ms,
            ingested_at_ms: context.ingested_at_ms,
            last_retrieved_at_ms: request.now_ms,
            content: request.content,
        };
        let request_hash = canonical_remember_hash(&memory, &vector);

        if let Some(key) = &request.idempotency_key {
            let ledger_key = RememberIdempotencyRecord::durable_key(&self.tenant_id, key);
            if let Some(record) = self.hyphae.get_record(&ledger_key)? {
                let existing = RememberIdempotencyRecord::from_record(&record)?;
                if existing.request_hash != request_hash {
                    return Err(MemoryEngineError::IdempotencyConflict);
                }
                let record = self
                    .hyphae
                    .get_record(existing.memory_id.as_bytes())?
                    .ok_or_else(|| MemoryEngineError::BrokenIdempotencyReference {
                        id: existing.memory_id.clone(),
                    })?;
                let existing_memory = Memory::from_record(&record)?;
                // Repair a vector write interrupted after the atomic document commit.
                if existing_memory
                    .governance
                    .as_ref()
                    .is_none_or(|state| state.0.treatment != Treatment::Quarantined)
                {
                    self.hyphae.put_vectors(
                        deterministic_phase_uuid(&self.tenant_id, key, "vector"),
                        &memory_space(),
                        &[(existing.memory_id.as_bytes().to_vec(), vector)],
                    )?;
                }
                return Ok(existing_memory);
            }
        }

        let quarantined = governance.treatment == Treatment::Quarantined;
        if let Some(key) = &request.idempotency_key {
            let ledger = RememberIdempotencyRecord::new(memory.id.clone(), request_hash);
            self.hyphae.put_records(
                deterministic_phase_uuid(&self.tenant_id, key, "documents"),
                &[memory.to_record(), ledger.to_record(&self.tenant_id, key)],
            )?;
            if !quarantined {
                self.hyphae.put_vectors(
                    deterministic_phase_uuid(&self.tenant_id, key, "vector"),
                    &memory_space(),
                    &[(memory.key(), vector)],
                )?;
            }
        } else {
            self.hyphae
                .put_record(Uuid::now_v7(), &memory.to_record())?;
            if !quarantined {
                self.hyphae.put_vectors(
                    Uuid::now_v7(),
                    &memory_space(),
                    &[(memory.key(), vector)],
                )?;
            }
        }
        if !quarantined {
            self.index_entities(&memory)?;
        }
        self.append_audit(
            GovernedOperation::Store,
            &memory.id,
            Some(&memory.provenance.content_hash),
            request.purpose,
            governance.treatment,
            audit_decision_for_enforcement(governance.enforcement),
            governance_reason_codes(&governance),
            request.now_ms,
        )?;

        // The stimulus moves the engine's own emotional state — the
        // amygdala pass of the TS pipeline (limbic.updateState on input).
        self.update_affect(memory.pad, &[], request.now_ms)?;

        // And ticks the circadian rhythm: every remember is a session
        // interaction; strong affect also spikes the accumulator.
        self.record_circadian_event(CircadianEvent::SessionActive, request.now_ms)?;
        let emotional_intensity = memory.pad.arousal.abs().max(memory.pad.pleasure.abs());
        if emotional_intensity > 0.5 {
            self.circadian
                .factors
                .record_event(CircadianEvent::EmotionalSpike {
                    intensity: emotional_intensity,
                });
            self.persist_circadian(request.now_ms)?;
        }
        Ok(memory)
    }

    /// Memories bound to one entity, newest binding last — the reverse
    /// edge of the memory graph. Name matching is case-insensitive.
    ///
    /// # Errors
    ///
    /// Fails on storage or decoding failure.
    pub fn entity_memories(
        &self,
        kind: celiums_cognition::EntityKind,
        name: &str,
    ) -> Result<Vec<Memory>, MemoryEngineError> {
        let Some(record) = self.hyphae.get_record(&entity_key(kind, name))? else {
            return Ok(Vec::new());
        };
        let entity = EntityRecord::from_record(&record)?;
        entity
            .memory_ids
            .iter()
            .map(|id| self.load_memory(id.as_bytes()))
            .collect()
    }

    /// Memories bound to a legacy extracted entity, filtered by scope and disclosure.
    pub fn entity_memories_scoped(
        &self,
        kind: celiums_cognition::EntityKind,
        name: &str,
        scope: &RecallScope,
        authority: celiums_cognition::DisclosureAuthority,
        purpose: MemoryPurpose,
    ) -> Result<Vec<EntityMemoryView>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let Some(record) = self.hyphae.get_record(&entity_key(kind, name))? else {
            return Ok(Vec::new());
        };
        let entity = EntityRecord::from_record(&record)?;
        let mut views = Vec::new();
        for id in entity.memory_ids {
            let Some(memory) = self.get_memory(&id, scope)? else {
                continue;
            };
            if memory.state == MemoryState::Archived {
                continue;
            }
            let (disclosure, disclosed_content) = disclose_memory(&memory, authority, purpose);
            if disclosure != celiums_cognition::DisclosureClass::Abstain {
                views.push(EntityMemoryView {
                    memory,
                    disclosed_content,
                    disclosure,
                });
            }
        }
        Ok(views)
    }

    /// All indexed entities, ordered by kind then name.
    ///
    /// # Errors
    ///
    /// Fails on storage or decoding failure.
    pub fn entities(&self) -> Result<Vec<EntityRecord>, MemoryEngineError> {
        self.scan_prefix(&entity_prefix())?
            .iter()
            .map(|record| EntityRecord::from_record(record).map_err(MemoryEngineError::from))
            .collect()
    }

    /// Defines one configurable entity type in a versioned ontology.
    pub fn define_entity_type(
        &mut self,
        request: DefineEntityTypeRequest,
    ) -> Result<EntityTypeDefinition, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_graph_text(&request.type_id, "type_id")?;
        validate_graph_text(&request.ontology_version, "ontology_version")?;
        let definition = EntityTypeDefinition::from_request(request);
        self.hyphae
            .put_record(Uuid::now_v7(), &definition.to_record())?;
        Ok(definition)
    }

    /// Lists visible ontology entity type definitions.
    pub fn entity_types(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<EntityTypeDefinition>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let definitions = self
            .scan_prefix(EntityTypeDefinition::prefix())?
            .iter()
            .map(EntityTypeDefinition::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(definitions
            .into_iter()
            .filter(|definition| graph_scope_visible(&definition.scope, scope))
            .collect())
    }

    /// Defines one typed, versioned entity relation.
    pub fn define_relation_type(
        &mut self,
        request: DefineRelationTypeRequest,
    ) -> Result<RelationTypeDefinition, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_graph_text(&request.relation_type, "relation_type")?;
        validate_graph_text(&request.ontology_version, "ontology_version")?;
        if request.source_entity_types.is_empty() || request.target_entity_types.is_empty() {
            return Err(InvalidGraph::LineageTargets.into());
        }
        for entity_type in request
            .source_entity_types
            .iter()
            .chain(request.target_entity_types.iter())
        {
            self.require_entity_type(&request.scope, entity_type)?;
        }
        let definition = RelationTypeDefinition::from_request(request);
        self.hyphae
            .put_record(Uuid::now_v7(), &definition.to_record())?;
        Ok(definition)
    }

    /// Creates one evidence-backed typed temporal edge.
    pub fn create_entity_relation(
        &mut self,
        request: CreateEntityRelationRequest,
    ) -> Result<EntityRelation, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_graph_text(&request.relation_type, "relation_type")?;
        validate_interval(request.valid_from_ms, request.valid_to_ms)?;
        if !request.confidence.is_finite() || !(0.0..=1.0).contains(&request.confidence) {
            return Err(InvalidGraph::Validity.into());
        }
        let source = self
            .get_entity(&request.source_entity_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::GraphEntityNotFound {
                entity_id: request.source_entity_id.to_string(),
            })?;
        let target = self
            .get_entity(&request.target_entity_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::GraphEntityNotFound {
                entity_id: request.target_entity_id.to_string(),
            })?;
        let definition = self
            .relation_types(&request.scope)?
            .into_iter()
            .filter(|definition| definition.relation_type == request.relation_type)
            .max_by(|left, right| {
                left.recorded_at_ms
                    .cmp(&right.recorded_at_ms)
                    .then_with(|| left.ontology_version.cmp(&right.ontology_version))
            })
            .ok_or_else(|| MemoryEngineError::GraphRelationTypeNotFound {
                relation_type: request.relation_type.clone(),
            })?;
        if !definition.source_entity_types.contains(&source.entity_type)
            || !definition.target_entity_types.contains(&target.entity_type)
        {
            return Err(MemoryEngineError::GraphRelationEndpointType);
        }
        if request.evidence.is_empty() {
            return Err(InvalidGraph::Evidence.into());
        }
        self.validate_graph_evidence(&request.scope, &request.evidence)?;
        let relation = EntityRelation::from_request(&request, &definition);
        if let Some(record) = self.hyphae.get_record(&EntityRelation::key(&relation.id))? {
            return Ok(EntityRelation::from_record(&record)?);
        }
        self.hyphae
            .put_record(Uuid::now_v7(), &relation.to_record())?;
        Ok(relation)
    }

    /// Lists relation type definitions visible to this graph scope.
    pub fn relation_types(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<RelationTypeDefinition>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let definitions = self
            .scan_prefix(RelationTypeDefinition::prefix())?
            .iter()
            .map(RelationTypeDefinition::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(definitions
            .into_iter()
            .filter(|definition| graph_scope_visible(&definition.scope, scope))
            .collect())
    }

    /// Lists visible entity relations valid and known at the requested times.
    pub fn entity_relations_at(
        &self,
        scope: &RecallScope,
        valid_at_ms: i64,
        known_at_ms: i64,
    ) -> Result<Vec<EntityRelation>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let relations = self
            .scan_prefix(EntityRelation::prefix())?
            .iter()
            .map(EntityRelation::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(relations
            .into_iter()
            .filter(|relation| graph_scope_visible(&relation.scope, scope))
            .filter(|relation| relation.valid_at(valid_at_ms, known_at_ms))
            .collect())
    }

    /// Traverses visible temporal graph edges under strict budgets.
    pub fn traverse_graph(
        &self,
        request: GraphTraversalRequest,
    ) -> Result<GraphTraversalResult, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        let max_depth = request.max_depth.clamp(1, 8);
        let max_edges = request.max_edges.clamp(1, 1_000);
        let max_entities = request.max_entities.clamp(1, 1_000);
        let mut seeds = request.seeds;
        seeds.sort();
        seeds.dedup();
        for seed in &seeds {
            if self.get_entity(seed, &request.scope)?.is_none() {
                return Err(MemoryEngineError::GraphEntityNotFound {
                    entity_id: seed.to_string(),
                });
            }
        }
        if seeds.len() > max_entities {
            return Ok(GraphTraversalResult {
                entities: seeds.into_iter().take(max_entities).collect(),
                edges: Vec::new(),
                inspected_edges: 0,
                truncated: true,
                truncation_reason: Some(GraphTruncationReason::Entities),
            });
        }
        let mut relations = self
            .entity_relations_at(&request.scope, request.valid_at_ms, request.known_at_ms)?
            .into_iter()
            .filter(|relation| relation.traversable)
            .filter(|relation| {
                request.relation_types.is_empty()
                    || request.relation_types.contains(&relation.relation_type)
            })
            .collect::<Vec<_>>();
        relations.sort_by(|left, right| left.id.cmp(&right.id));

        let mut entities = seeds.clone();
        let mut visited: std::collections::BTreeSet<EntityId> = seeds.iter().cloned().collect();
        let mut queue: std::collections::VecDeque<(EntityId, usize)> =
            seeds.into_iter().map(|id| (id, 0)).collect();
        let mut edges = Vec::new();
        let mut inspected_edges = 0;
        let mut truncation_reason = None;

        while let Some((entity_id, depth)) = queue.pop_front() {
            for relation in relations.iter().filter(|relation| {
                relation.source_entity_id == entity_id
                    || (relation.direction == RelationDirection::Undirected
                        && relation.target_entity_id == entity_id)
            }) {
                inspected_edges += 1;
                let neighbor = if relation.source_entity_id == entity_id {
                    &relation.target_entity_id
                } else {
                    &relation.source_entity_id
                };
                if depth >= max_depth {
                    if !visited.contains(neighbor) {
                        truncation_reason.get_or_insert(GraphTruncationReason::Depth);
                    }
                    continue;
                }
                if edges.len() >= max_edges {
                    truncation_reason.get_or_insert(GraphTruncationReason::Edges);
                    break;
                }
                if !edges
                    .iter()
                    .any(|edge: &TraversedEdge| edge.relation.id == relation.id)
                {
                    edges.push(TraversedEdge {
                        relation: relation.clone(),
                        depth: depth + 1,
                    });
                }
                if !visited.contains(neighbor) {
                    if entities.len() >= max_entities {
                        truncation_reason.get_or_insert(GraphTruncationReason::Entities);
                        continue;
                    }
                    visited.insert(neighbor.clone());
                    entities.push(neighbor.clone());
                    queue.push_back((neighbor.clone(), depth + 1));
                }
            }
            if truncation_reason == Some(GraphTruncationReason::Edges) {
                break;
            }
        }

        Ok(GraphTraversalResult {
            entities,
            edges,
            inspected_edges,
            truncated: truncation_reason.is_some(),
            truncation_reason,
        })
    }

    /// Binds a visible memory to one visible canonical entity.
    pub fn bind_memory_entity(
        &mut self,
        memory_id: &str,
        entity_id: &EntityId,
        scope: &RecallScope,
    ) -> Result<GraphMemoryBinding, MemoryEngineError> {
        let memory = self.get_memory(memory_id, scope)?.ok_or_else(|| {
            MemoryEngineError::MissingCandidate {
                id: memory_id.to_owned(),
            }
        })?;
        if self.get_entity(entity_id, scope)?.is_none() {
            return Err(MemoryEngineError::GraphEntityNotFound {
                entity_id: entity_id.to_string(),
            });
        }
        let binding = GraphMemoryBinding::new(
            scope.clone(),
            entity_id.clone(),
            memory.id,
            memory.ingested_at_ms,
        );
        self.hyphae
            .put_record(Uuid::now_v7(), &binding.to_record())?;
        Ok(binding)
    }

    /// Runs standard recall plus bounded graph candidate generation.
    pub fn recall_with_graph(
        &mut self,
        request: GraphRecallRequest,
    ) -> Result<GraphRecallResponse, MemoryEngineError> {
        let scope = request
            .recall
            .scope
            .clone()
            .unwrap_or_else(RecallScope::local);
        let direct = self.recall(request.recall.clone())?;
        let mut paths: BTreeMap<String, Vec<EntityId>> = BTreeMap::new();
        let mut seeds =
            self.graph_query_seeds(&scope, &request.recall.query_text, request.recall.now_ms)?;
        for scored in &direct.results {
            seeds.extend(self.bound_entity_ids(&scored.memory.id, &scope)?);
        }
        seeds.sort();
        seeds.dedup();
        let traversal = if seeds.is_empty() {
            GraphTraversalResult {
                entities: Vec::new(),
                edges: Vec::new(),
                inspected_edges: 0,
                truncated: false,
                truncation_reason: None,
            }
        } else {
            self.traverse_graph(GraphTraversalRequest {
                scope: scope.clone(),
                seeds: seeds.clone(),
                relation_types: Vec::new(),
                valid_at_ms: request.recall.now_ms,
                known_at_ms: request.recall.now_ms,
                max_depth: request.max_depth,
                max_edges: request.max_edges,
                max_entities: request.max_entities,
            })?
        };
        for entity_id in traversal.entities.iter().take(request.max_entities) {
            for binding in self.memory_bindings(entity_id, &scope)? {
                paths
                    .entry(binding.memory_id)
                    .or_insert_with(|| graph_path(&seeds, entity_id, &traversal));
                if paths.len() >= request.max_memories {
                    break;
                }
            }
        }

        let mut results: BTreeMap<String, GraphScoredMemory> = direct
            .results
            .into_iter()
            .map(|scored| {
                (
                    scored.memory.id.clone(),
                    GraphScoredMemory {
                        memory: scored.memory,
                        channels: scored.channels,
                        final_score: scored.final_score,
                        graph_score: 0.0,
                        disclosed_content: scored.disclosed_content,
                        disclosure: scored.disclosure,
                        graph_path: Vec::new(),
                    },
                )
            })
            .collect();
        for (memory_id, path) in paths {
            if results.contains_key(&memory_id) {
                continue;
            }
            let Some(memory) = self.get_memory(&memory_id, &scope)? else {
                continue;
            };
            if memory.state == MemoryState::Archived {
                continue;
            }
            let channels = graph_candidate_channels(&memory, request.recall.now_ms);
            let current_state = request
                .recall
                .current_state
                .unwrap_or_else(|| self.affect_state(request.recall.now_ms));
            let cognitive = recall::score(&self.config.weights, &channels, current_state.arousal);
            let graph_score = 1.0 / path.len().saturating_sub(1).max(1) as f64;
            let final_score = cognitive + GRAPH_CANDIDATE_WEIGHT * graph_score;
            let (disclosure, disclosed_content) = disclose_memory(
                &memory,
                request.recall.disclosure_authority,
                request.recall.disclosure_purpose,
            );
            if disclosure == celiums_cognition::DisclosureClass::Abstain {
                continue;
            }
            if final_score < self.config.score_threshold {
                continue;
            }
            results.insert(
                memory_id,
                GraphScoredMemory {
                    memory,
                    channels,
                    final_score,
                    graph_score,
                    disclosed_content,
                    disclosure,
                    graph_path: path,
                },
            );
        }
        let mut results: Vec<GraphScoredMemory> = results.into_values().collect();
        results.sort_by(|left, right| {
            right
                .final_score
                .partial_cmp(&left.final_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.memory.id.cmp(&right.memory.id))
        });
        results.truncate(request.recall.limit.max(1));
        Ok(GraphRecallResponse {
            results,
            graph_truncated: traversal.truncated,
            graph_truncation_reason: traversal.truncation_reason,
            graph_inspected_edges: traversal.inspected_edges,
        })
    }

    /// Performs an exhaustive offline integrity check over the visible graph.
    pub fn graph_verify(
        &self,
        scope: &RecallScope,
    ) -> Result<GraphIntegrityReport, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let entities = self.visible_canonical_entities(scope)?;
        let entity_ids: std::collections::BTreeSet<EntityId> =
            entities.iter().map(|entity| entity.id.clone()).collect();
        let relations = self
            .scan_prefix(EntityRelation::prefix())?
            .iter()
            .map(EntityRelation::from_record)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|relation| graph_scope_visible(&relation.scope, scope))
            .collect::<Vec<_>>();
        let bindings = self
            .scan_prefix(GraphMemoryBinding::prefix())?
            .iter()
            .map(GraphMemoryBinding::from_record)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|binding| graph_scope_visible(&binding.scope, scope))
            .collect::<Vec<_>>();
        let relation_types = self.relation_types(scope)?;
        let mut issues = Vec::new();
        for relation in &relations {
            if !entity_ids.contains(&relation.source_entity_id) {
                issues.push(GraphIntegrityIssue {
                    kind: "missing_source_entity".to_owned(),
                    subject_id: relation.id.to_string(),
                });
            }
            if !entity_ids.contains(&relation.target_entity_id) {
                issues.push(GraphIntegrityIssue {
                    kind: "missing_target_entity".to_owned(),
                    subject_id: relation.id.to_string(),
                });
            }
            if relation.evidence.is_empty()
                || relation.evidence_count != relation.evidence.len() as u64
            {
                issues.push(GraphIntegrityIssue {
                    kind: "invalid_evidence_count".to_owned(),
                    subject_id: relation.id.to_string(),
                });
            }
            if !relation_types.iter().any(|definition| {
                definition.relation_type == relation.relation_type
                    && definition.ontology_version == relation.ontology_version
            }) {
                issues.push(GraphIntegrityIssue {
                    kind: "missing_relation_type".to_owned(),
                    subject_id: relation.id.to_string(),
                });
            }
            for evidence in &relation.evidence {
                if self.get_ingestion(&evidence.event_id, scope)?.is_none() {
                    issues.push(GraphIntegrityIssue {
                        kind: "missing_relation_evidence".to_owned(),
                        subject_id: relation.id.to_string(),
                    });
                }
            }
        }
        for entity in &entities {
            if entity.evidence.is_empty() || entity.evidence_count != entity.evidence.len() as u64 {
                issues.push(GraphIntegrityIssue {
                    kind: "invalid_entity_evidence".to_owned(),
                    subject_id: entity.id.to_string(),
                });
            }
            for evidence in &entity.evidence {
                if self.get_ingestion(&evidence.event_id, scope)?.is_none() {
                    issues.push(GraphIntegrityIssue {
                        kind: "missing_entity_evidence".to_owned(),
                        subject_id: entity.id.to_string(),
                    });
                }
            }
        }
        for binding in &bindings {
            if !entity_ids.contains(&binding.entity_id) {
                issues.push(GraphIntegrityIssue {
                    kind: "missing_binding_entity".to_owned(),
                    subject_id: binding.memory_id.clone(),
                });
            }
            if self.get_memory(&binding.memory_id, scope)?.is_none() {
                issues.push(GraphIntegrityIssue {
                    kind: "missing_binding_memory".to_owned(),
                    subject_id: binding.memory_id.clone(),
                });
            }
        }
        Ok(GraphIntegrityReport {
            valid: issues.is_empty(),
            entity_count: entities.len(),
            relation_count: relations.len(),
            binding_count: bindings.len(),
            issues,
        })
    }

    fn visible_canonical_entities(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<CanonicalEntity>, MemoryEngineError> {
        let entities = self
            .scan_prefix(CanonicalEntity::prefix())?
            .iter()
            .map(CanonicalEntity::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(entities
            .into_iter()
            .filter(|entity| graph_scope_visible(&entity.scope, scope))
            .collect())
    }

    fn graph_query_seeds(
        &self,
        scope: &RecallScope,
        query: &str,
        now_ms: i64,
    ) -> Result<Vec<EntityId>, MemoryEngineError> {
        let aliases = self
            .scan_prefix(EntityAlias::prefix())?
            .iter()
            .map(EntityAlias::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        let query = normalize_label(query);
        let mut seeds = Vec::new();
        for (alias, owner, _) in aliases {
            if graph_scope_visible(&owner, scope)
                && alias.valid_at(now_ms, now_ms)
                && query.contains(&alias.normalized_alias)
            {
                seeds.push(alias.entity_id);
            }
        }
        Ok(seeds)
    }

    fn memory_bindings(
        &self,
        entity_id: &EntityId,
        scope: &RecallScope,
    ) -> Result<Vec<GraphMemoryBinding>, MemoryEngineError> {
        let bindings = self
            .scan_prefix(GraphMemoryBinding::prefix())?
            .iter()
            .map(GraphMemoryBinding::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(bindings
            .into_iter()
            .filter(|binding| binding.entity_id == *entity_id)
            .filter(|binding| graph_scope_visible(&binding.scope, scope))
            .collect())
    }

    fn bound_entity_ids(
        &self,
        memory_id: &str,
        scope: &RecallScope,
    ) -> Result<Vec<EntityId>, MemoryEngineError> {
        let bindings = self
            .scan_prefix(GraphMemoryBinding::prefix())?
            .iter()
            .map(GraphMemoryBinding::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(bindings
            .into_iter()
            .filter(|binding| binding.memory_id == memory_id)
            .filter(|binding| graph_scope_visible(&binding.scope, scope))
            .map(|binding| binding.entity_id)
            .collect())
    }

    /// Creates a stable canonical entity and its exact canonical-label alias.
    pub fn create_entity(
        &mut self,
        request: CreateEntityRequest,
    ) -> Result<CanonicalEntity, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_graph_text(&request.entity_type, "entity_type")?;
        validate_graph_text(&request.canonical_label, "canonical_label")?;
        if request.evidence.is_empty() {
            return Err(InvalidGraph::Evidence.into());
        }
        self.require_entity_type(&request.scope, &request.entity_type)?;
        self.validate_graph_evidence(&request.scope, &request.evidence)?;
        let entity = CanonicalEntity::from_request(&request);
        if let Some(existing) = self.get_entity(&entity.id, &request.scope)? {
            return Ok(existing);
        }
        let alias = EntityAlias::from_request(&EntityAliasRequest {
            scope: request.scope.clone(),
            entity_id: entity.id.clone(),
            alias: request.canonical_label,
            valid_from_ms: None,
            valid_to_ms: None,
            recorded_at_ms: request.recorded_at_ms,
            evidence: Vec::new(),
        });
        self.hyphae.put_records(
            Uuid::now_v7(),
            &[
                entity.to_record(),
                alias.to_record(&entity.scope, &entity.entity_type),
            ],
        )?;
        Ok(entity)
    }

    /// Gets one visible canonical entity.
    pub fn get_entity(
        &self,
        entity_id: &EntityId,
        scope: &RecallScope,
    ) -> Result<Option<CanonicalEntity>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let Some(record) = self.hyphae.get_record(&CanonicalEntity::key(entity_id))? else {
            return Ok(None);
        };
        let entity = CanonicalEntity::from_record(&record)?;
        Ok(graph_scope_visible(&entity.scope, scope).then_some(entity))
    }

    /// Adds one temporal alias to a visible entity.
    pub fn add_entity_alias(
        &mut self,
        request: EntityAliasRequest,
    ) -> Result<EntityAlias, MemoryEngineError> {
        validate_graph_text(&request.alias, "alias")?;
        validate_interval(request.valid_from_ms, request.valid_to_ms)?;
        self.validate_graph_evidence(&request.scope, &request.evidence)?;
        let entity = self
            .get_entity(&request.entity_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::GraphEntityNotFound {
                entity_id: request.entity_id.to_string(),
            })?;
        let alias = EntityAlias::from_request(&request);
        self.hyphae.put_record(
            Uuid::now_v7(),
            &alias.to_record(&request.scope, &entity.entity_type),
        )?;
        Ok(alias)
    }

    /// Resolves an exact normalized alias, surfacing ambiguity explicitly.
    pub fn resolve_entity_alias(
        &self,
        scope: &RecallScope,
        entity_type: &str,
        alias: &str,
        valid_at_ms: i64,
        known_at_ms: i64,
    ) -> Result<EntityResolution, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let normalized = normalize_label(alias);
        let aliases = self
            .scan_prefix(EntityAlias::prefix())?
            .iter()
            .map(EntityAlias::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        let mut matches = Vec::new();
        for (candidate, owner, candidate_type) in aliases {
            if candidate_type == entity_type
                && candidate.normalized_alias == normalized
                && candidate.valid_at(valid_at_ms, known_at_ms)
                && graph_scope_visible(&owner, scope)
            {
                matches.push(candidate.entity_id);
            }
        }
        matches.sort();
        matches.dedup();
        Ok(resolution(matches))
    }

    /// Records an append-only merge or split event.
    pub fn record_entity_lineage(
        &mut self,
        request: EntityLineageRequest,
    ) -> Result<EntityLineage, MemoryEngineError> {
        let expected_targets = match request.lineage_type {
            EntityLineageType::MergedInto => 1,
            EntityLineageType::SplitInto => 2,
        };
        if request.target_entity_ids.len() < expected_targets {
            return Err(InvalidGraph::LineageTargets.into());
        }
        if request.evidence.is_empty() {
            return Err(InvalidGraph::Evidence.into());
        }
        let source = self
            .get_entity(&request.source_entity_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::GraphEntityNotFound {
                entity_id: request.source_entity_id.to_string(),
            })?;
        for target_id in &request.target_entity_ids {
            let target = self.get_entity(target_id, &request.scope)?.ok_or_else(|| {
                MemoryEngineError::GraphEntityNotFound {
                    entity_id: target_id.to_string(),
                }
            })?;
            if source.entity_type != target.entity_type {
                return Err(MemoryEngineError::GraphEntityTypeNotFound {
                    entity_type: target.entity_type,
                });
            }
            if self.entity_reaches(target_id, &source.id, &request.scope)? {
                return Err(MemoryEngineError::GraphLineageCycle);
            }
        }
        self.validate_graph_evidence(&request.scope, &request.evidence)?;
        let lineage = EntityLineage::from_request(&request);
        self.hyphae
            .put_record(Uuid::now_v7(), &lineage.to_record(&request.scope))?;
        Ok(lineage)
    }

    /// Resolves visible merge/split lineage at valid and transaction time.
    pub fn resolve_entity_id(
        &self,
        entity_id: &EntityId,
        scope: &RecallScope,
        valid_at_ms: i64,
        known_at_ms: i64,
    ) -> Result<EntityResolution, MemoryEngineError> {
        if self.get_entity(entity_id, scope)?.is_none() {
            return Ok(EntityResolution::NotFound);
        }
        let lineages = self.visible_entity_lineages(scope)?;
        let mut current = vec![entity_id.clone()];
        let mut visited = std::collections::BTreeSet::new();
        loop {
            let mut next = Vec::new();
            let mut changed = false;
            for id in current {
                if !visited.insert(id.clone()) {
                    return Err(MemoryEngineError::GraphLineageCycle);
                }
                let applicable = lineages.iter().find(|lineage| {
                    lineage.source_entity_id == id
                        && lineage.effective_at_ms <= valid_at_ms
                        && lineage.recorded_at_ms <= known_at_ms
                });
                match applicable {
                    Some(lineage) => {
                        next.extend(lineage.target_entity_ids.clone());
                        changed = true;
                    }
                    None => next.push(id),
                }
            }
            next.sort();
            next.dedup();
            if !changed {
                return Ok(resolution(next));
            }
            current = next;
        }
    }

    fn require_entity_type(
        &self,
        scope: &RecallScope,
        entity_type: &str,
    ) -> Result<(), MemoryEngineError> {
        if built_in_entity_type(entity_type)
            || self
                .entity_types(scope)?
                .iter()
                .any(|definition| definition.type_id == entity_type)
        {
            return Ok(());
        }
        Err(MemoryEngineError::GraphEntityTypeNotFound {
            entity_type: entity_type.to_owned(),
        })
    }

    fn validate_graph_evidence(
        &self,
        scope: &RecallScope,
        evidence: &[crate::GraphEvidenceInput],
    ) -> Result<(), MemoryEngineError> {
        for item in evidence {
            let event = self.get_ingestion(&item.event_id, scope)?.ok_or_else(|| {
                MemoryEngineError::GraphEvidenceNotFound {
                    event_id: item.event_id.to_string(),
                }
            })?;
            if item
                .excerpt
                .as_ref()
                .is_some_and(|excerpt| !event.content.contains(excerpt))
            {
                return Err(MemoryEngineError::GraphEvidenceExcerptMismatch {
                    event_id: item.event_id.to_string(),
                });
            }
        }
        Ok(())
    }

    fn visible_entity_lineages(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<EntityLineage>, MemoryEngineError> {
        let decoded = self
            .scan_prefix(EntityLineage::prefix())?
            .iter()
            .map(EntityLineage::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(decoded
            .into_iter()
            .filter(|(_, owner)| graph_scope_visible(owner, scope))
            .map(|(lineage, _)| lineage)
            .collect())
    }

    fn entity_reaches(
        &self,
        start: &EntityId,
        target: &EntityId,
        scope: &RecallScope,
    ) -> Result<bool, MemoryEngineError> {
        let lineages = self.visible_entity_lineages(scope)?;
        let mut pending = vec![start.clone()];
        let mut visited = std::collections::BTreeSet::new();
        while let Some(current) = pending.pop() {
            if &current == target {
                return Ok(true);
            }
            if !visited.insert(current.clone()) {
                continue;
            }
            pending.extend(
                lineages
                    .iter()
                    .filter(|lineage| lineage.source_entity_id == current)
                    .flat_map(|lineage| lineage.target_entity_ids.clone()),
            );
        }
        Ok(false)
    }

    fn index_entities(&mut self, memory: &Memory) -> Result<(), MemoryEngineError> {
        for extracted in &memory.entities {
            let key = entity_key(extracted.kind, &extracted.name);
            let mut entity = match self.hyphae.get_record(&key)? {
                Some(record) => EntityRecord::from_record(&record)?,
                None => EntityRecord {
                    name: extracted.name.to_lowercase(),
                    kind: extracted.kind,
                    salience: extracted.salience,
                    memory_ids: Vec::new(),
                },
            };
            if !entity.memory_ids.contains(&memory.id) {
                entity.memory_ids.push(memory.id.clone());
            }
            entity.salience = entity.salience.max(extracted.salience);
            self.hyphae
                .put_record(Uuid::now_v7(), &entity.to_record())?;
        }
        Ok(())
    }

    fn unindex_entities(&mut self, memory: &Memory) -> Result<(), MemoryEngineError> {
        for extracted in &memory.entities {
            let key = entity_key(extracted.kind, &extracted.name);
            let Some(record) = self.hyphae.get_record(&key)? else {
                continue;
            };
            let mut entity = EntityRecord::from_record(&record)?;
            entity.memory_ids.retain(|id| id != &memory.id);
            if entity.memory_ids.is_empty() {
                self.hyphae.delete_record(Uuid::now_v7(), &key)?;
                continue;
            }
            entity.salience = self.entity_salience(&entity)?;
            self.hyphae
                .put_record(Uuid::now_v7(), &entity.to_record())?;
        }
        Ok(())
    }

    fn entity_salience(&self, entity: &EntityRecord) -> Result<f64, MemoryEngineError> {
        let mut maximum: f64 = 0.0;
        for id in &entity.memory_ids {
            let memory = self.load_memory(id.as_bytes())?;
            for extracted in &memory.entities {
                if extracted.kind == entity.kind
                    && extracted.name.eq_ignore_ascii_case(&entity.name)
                {
                    maximum = maximum.max(extracted.salience);
                }
            }
        }
        Ok(maximum)
    }

    /// Recalls memories for a query: hybrid candidate retrieval,
    /// cognitive re-ranking, then spaced-repetition reactivation of the
    /// top results.
    ///
    /// # Errors
    ///
    /// Fails on quantisation, retrieval, or decoding failure. A store
    /// whose index disagrees with its log surfaces
    /// [`MemoryEngineError::MissingCandidate`] instead of skipping.
    pub fn recall(&mut self, request: RecallRequest) -> Result<RecallResponse, MemoryEngineError> {
        let scope = request.scope.clone().unwrap_or_else(RecallScope::local);
        self.require_tenant(&scope.tenant_id)?;
        let requested_space = request
            .embedding_space
            .as_ref()
            .unwrap_or(&self.embedding_space);
        ensure_embedding_space(&self.embedding_space, requested_space)?;
        let query_vector = quantize(&request.embedding, self.dimension)?;
        let candidate_limit = request.limit.max(1).saturating_mul(CANDIDATE_FACTOR);

        let (semantic_scores, semantic_abstention) =
            self.semantic_candidates(query_vector, candidate_limit)?;
        let (lexical_scores, lexical_abstention) =
            self.lexical_candidates(&request.query_text, candidate_limit)?;

        let mut candidates: BTreeMap<Vec<u8>, (f64, f64)> = BTreeMap::new();
        for (key, semantic) in semantic_scores {
            candidates.entry(key).or_insert((0.0, 0.0)).0 = semantic;
        }
        for (key, lexical) in lexical_scores {
            candidates.entry(key).or_insert((0.0, 0.0)).1 = lexical;
        }

        let current_state = request
            .current_state
            .unwrap_or_else(|| self.affect_state(request.now_ms));

        let mut scored = Vec::with_capacity(candidates.len());
        for (key, (semantic, text_match)) in candidates {
            let Some(memory) = self.load_recall_candidate(&key)? else {
                continue;
            };
            if memory.state == MemoryState::Archived || !memory_visible_to(&memory, &scope) {
                continue;
            }
            let channels = ChannelScores {
                semantic,
                text_match,
                importance: memory.importance,
                retrievability: retrievability(
                    days_between(memory.last_retrieved_at_ms, request.now_ms),
                    memory.strength,
                ),
                emotional: emotional_weight(memory.pad.pleasure, memory.pad.arousal),
                resonance: resonance(current_state, memory.pad),
            };
            let final_score = recall::score(&self.config.weights, &channels, current_state.arousal);
            let (disclosure, disclosed_content) = disclose_memory(
                &memory,
                request.disclosure_authority,
                request.disclosure_purpose,
            );
            scored.push(ScoredMemory {
                memory,
                channels,
                final_score,
                disclosed_content,
                disclosure,
            });
        }

        scored.retain(|entry| {
            entry.final_score >= self.config.score_threshold
                && entry.disclosure != celiums_cognition::DisclosureClass::Abstain
        });
        scored.sort_by(|left, right| {
            right
                .final_score
                .partial_cmp(&left.final_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.memory.id.cmp(&right.memory.id))
        });
        scored.truncate(self.config.max_results.min(request.limit.max(1)));

        if self.config.enable_reactivation {
            self.reactivate_top(&mut scored, request.now_ms)?;
        }

        // Hippocampal feedback: recalled memories pull the engine's
        // emotional state (the γ term of the limbic update). The input
        // term is zero here; `remember` covers the stimulus side.
        if request.current_state.is_none() && !scored.is_empty() {
            let influences: Vec<MemoryInfluence> = scored
                .iter()
                .take(REACTIVATION_TOP)
                .map(|entry| MemoryInfluence {
                    pad: entry.memory.pad,
                    weight: entry.memory.importance,
                })
                .collect();
            self.update_affect(Pad::default(), &influences, request.now_ms)?;
        }

        Ok(RecallResponse {
            results: scored,
            lexical_abstention,
            semantic_abstention,
        })
    }

    fn require_tenant(&self, requested: &TenantId) -> Result<(), MemoryEngineError> {
        if requested == &self.tenant_id {
            return Ok(());
        }
        Err(MemoryEngineError::TenantMismatch {
            requested: requested.to_string(),
            engine: self.tenant_id.to_string(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn append_audit(
        &mut self,
        operation: GovernedOperation,
        subject_id: &str,
        content_digest: Option<&str>,
        purpose: MemoryPurpose,
        treatment: Treatment,
        decision: AuditDecision,
        reason_codes: Vec<String>,
        now_ms: i64,
    ) -> Result<EthicsAuditEntry, MemoryEngineError> {
        let previous_hash = self.audit_entries()?.last().map(|entry| entry.hash.clone());
        let mut entry = EthicsAuditEntry {
            id: Uuid::now_v7().to_string(),
            tenant_id: self.tenant_id.to_string(),
            operation,
            subject_id: subject_id.to_owned(),
            content_digest: content_digest.map(str::to_owned),
            purpose: purpose_name(purpose).to_owned(),
            treatment: treatment_name(treatment).to_owned(),
            policy_id: celiums_cognition::GOVERNANCE_POLICY_ID.to_owned(),
            policy_version: celiums_cognition::GOVERNANCE_POLICY_VERSION.to_owned(),
            decision,
            reason_codes,
            review_state: ReviewState::Unreviewed,
            actor_id: None,
            occurred_at_ms: now_ms,
            previous_hash,
            hash: String::new(),
        };
        entry.hash = entry.compute_hash();
        self.hyphae.put_record(Uuid::now_v7(), &entry.to_record())?;
        Ok(entry)
    }

    /// Lists this tenant's append-only ethics audit entries.
    pub fn audit_entries(&self) -> Result<Vec<EthicsAuditEntry>, MemoryEngineError> {
        self.scan_prefix(&audit_prefix())?
            .iter()
            .map(|record| EthicsAuditEntry::from_record(record).map_err(Into::into))
            .collect()
    }

    /// Verifies this tenant's ethics audit hash chain.
    pub fn audit_verify_chain(&self) -> Result<crate::AuditChainReport, MemoryEngineError> {
        Ok(crate::verify_audit_chain(
            self.tenant_id.as_str(),
            &self.audit_entries()?,
        ))
    }

    /// Evaluates and audits a proposed action without executing or storing it.
    ///
    /// # Errors
    ///
    /// Fails when the durable audit entry cannot be written.
    pub fn evaluate_action(
        &mut self,
        content: &str,
        source_kind: crate::SourceKind,
        purpose: MemoryPurpose,
        now_ms: i64,
    ) -> Result<ActionDecision, MemoryEngineError> {
        let ethics = evaluate_ethics(content, None);
        let context = RememberContext {
            identity: crate::MemoryIdentity::local(),
            provenance: crate::Provenance::observed(source_kind, content, None, None, None),
            event_at_ms: None,
            ingested_at_ms: now_ms,
        };
        let governance = classify_governance(
            content,
            source_trust(Some(&context)),
            celiums_cognition::ContentRole::OperationalRequest,
            purpose,
            now_ms,
            &ethics,
        );
        let allowed = matches!(
            governance.enforcement,
            celiums_cognition::EnforcementDecision::Allow
                | celiums_cognition::EnforcementDecision::AllowRestricted
        );
        let content_digest = blake3::hash(content.as_bytes()).to_hex().to_string();
        let audit = self.append_audit(
            GovernedOperation::Ingest,
            "action",
            Some(&content_digest),
            purpose,
            governance.treatment,
            audit_decision_for_enforcement(governance.enforcement),
            governance_reason_codes(&governance),
            now_ms,
        )?;
        Ok(ActionDecision {
            allowed,
            governance,
            audit,
        })
    }

    /// Appends feedback about an audit decision without modifying history.
    pub fn submit_ethics_feedback(
        &mut self,
        audit_entry_id: &str,
        kind: FeedbackKind,
        reason_code: &str,
        submitted_by: Option<String>,
        now_ms: i64,
    ) -> Result<FeedbackEntry, MemoryEngineError> {
        let entry = FeedbackEntry {
            id: Uuid::now_v7().to_string(),
            tenant_id: self.tenant_id.to_string(),
            audit_entry_id: audit_entry_id.to_owned(),
            kind,
            reason_code: reason_code.to_owned(),
            submitted_by,
            submitted_at_ms: now_ms,
        };
        self.hyphae.put_record(Uuid::now_v7(), &entry.to_record())?;
        Ok(entry)
    }

    /// Appends a review resolution; the original feedback remains immutable.
    pub fn resolve_ethics_feedback(
        &mut self,
        feedback_entry_id: &str,
        disposition: ReviewDisposition,
        reason_code: &str,
        reviewed_by: Option<String>,
        now_ms: i64,
    ) -> Result<FeedbackResolution, MemoryEngineError> {
        let resolution = FeedbackResolution {
            id: Uuid::now_v7().to_string(),
            tenant_id: self.tenant_id.to_string(),
            feedback_entry_id: feedback_entry_id.to_owned(),
            disposition,
            reason_code: reason_code.to_owned(),
            reviewed_by,
            resolved_at_ms: now_ms,
        };
        self.hyphae
            .put_record(Uuid::now_v7(), &resolution.to_record())?;
        Ok(resolution)
    }

    /// Lists append-only feedback and resolution records as canonical documents.
    pub fn ethics_feedback_records(&self) -> Result<Vec<hyphae_query::Record>, MemoryEngineError> {
        self.scan_prefix(&feedback_prefix())
    }

    /// Creates (or reuses) a verified snapshot of the current
    /// checkpoint — one durable time-travel point. Snapshots
    /// accumulate per checkpoint and survive compaction.
    ///
    /// # Errors
    ///
    /// Fails on storage failure.
    pub fn snapshot(&self) -> Result<crate::timetravel::SnapshotPoint, MemoryEngineError> {
        let info = self.hyphae.snapshot()?;
        Ok(crate::timetravel::SnapshotPoint {
            path: info.path,
            checkpoint_sequence: info.checkpoint_sequence,
        })
    }

    /// Total stored memories (internal state records excluded).
    ///
    /// # Errors
    ///
    /// Fails when the underlying query fails.
    pub fn count(&self) -> Result<u64, MemoryEngineError> {
        use hyphae_query::{CompareOperator, ExecutionLimits, Filter, Query, Value};
        let result = self.hyphae.query(
            &Query {
                filter: Filter::Compare {
                    path: FieldPath::field("kind"),
                    operator: CompareOperator::Equal,
                    value: Value::String(crate::memory::MEMORY_KIND.to_owned()),
                },
                sort: Vec::new(),
                cursor: None,
                limit: 1,
                aggregation: None,
            },
            &ExecutionLimits::default(),
        )?;
        Ok(result.matched_records)
    }

    /// Counts memories visible inside one authorization scope.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch or query execution failure.
    pub fn count_visible(&self, scope: &RecallScope) -> Result<u64, MemoryEngineError> {
        use hyphae_query::{ExecutionLimits, Query};
        self.require_tenant(&scope.tenant_id)?;
        let result = self.hyphae.query(
            &Query {
                filter: authorization_filter(scope),
                sort: Vec::new(),
                cursor: None,
                limit: 1,
                aggregation: None,
            },
            &ExecutionLimits::default(),
        )?;
        Ok(result.matched_records)
    }

    /// Gets one visible memory by ID without reactivation.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, storage, or decode failure.
    pub fn get_memory(
        &self,
        id: &str,
        scope: &RecallScope,
    ) -> Result<Option<Memory>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let Some(record) = self.hyphae.get_record(id.as_bytes())? else {
            return Ok(None);
        };
        let memory = Memory::from_record(&record)?;
        Ok(memory_visible_to(&memory, scope).then_some(memory))
    }

    /// Lists visible memories under one canonical filter.
    ///
    /// # Errors
    ///
    /// Fails on invalid filter, tenant mismatch, query, or decode failure.
    pub fn list_memories(
        &self,
        request: &ListMemoriesRequest,
    ) -> Result<MemoryPage, MemoryEngineError> {
        use hyphae_query::{
            ExecutionLimits, Filter, NullPlacement, Query, SortDirection, SortField,
        };
        self.require_tenant(&request.scope.tenant_id)?;
        let authorization = authorization_filter(&request.scope);
        let filter = match &request.filter {
            Some(filter) => Filter::All(vec![authorization, filter.compile()?]),
            None => authorization,
        };
        let result = self.hyphae.query(
            &Query {
                filter,
                sort: vec![SortField {
                    path: FieldPath::field("created_at_ms"),
                    direction: SortDirection::Descending,
                    nulls: NullPlacement::Last,
                }],
                cursor: None,
                limit: request.limit.clamp(1, 200),
                aggregation: None,
            },
            &ExecutionLimits::default(),
        )?;
        let memories = result
            .rows
            .iter()
            .map(Memory::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MemoryPage {
            memories,
            matched: result.matched_records,
        })
    }

    /// Updates mutable metadata using optimistic concurrency.
    ///
    /// # Errors
    ///
    /// Fails when the memory is invisible, the revision is stale, the patch
    /// is empty, or storage fails.
    pub fn update_memory(
        &mut self,
        request: UpdateMemoryRequest,
    ) -> Result<Option<Memory>, MemoryEngineError> {
        let Some(mut memory) = self.get_memory(&request.id, &request.scope)? else {
            return Ok(None);
        };
        if memory.revision != request.if_revision {
            return Err(MemoryEngineError::RevisionConflict {
                expected: request.if_revision,
                actual: memory.revision,
            });
        }
        if request.patch.importance.is_none()
            && request.patch.state.is_none()
            && request.patch.scope.is_none()
            && request.patch.tags.is_none()
            && request.patch.event_at_ms.is_none()
        {
            return Err(MemoryEngineError::EmptyPatch);
        }
        if let Some(value) = request.patch.importance {
            memory.importance = value.clamp(0.0, 1.0);
        }
        if let Some(value) = request.patch.state {
            memory.state = value;
        }
        if let Some(value) = request.patch.scope {
            validate_scope_identity(value, &memory.identity)?;
            memory.scope = value;
        }
        if let Some(value) = request.patch.tags {
            memory.tags = value;
        }
        if let Some(value) = request.patch.event_at_ms {
            memory.event_at_ms = value;
        }
        memory.revision = memory.revision.saturating_add(1);
        memory.updated_at_ms = request.now_ms;
        self.hyphae
            .put_record(Uuid::now_v7(), &memory.to_record())?;
        Ok(Some(memory))
    }

    /// Hard-deletes one visible memory and cleans its reverse entity bindings.
    ///
    /// The document and vector APIs are idempotent independently. Entity
    /// cleanup executes first; any interruption leaves the memory recoverable
    /// and a retry completes cleanup without exposing cross-scope existence.
    ///
    /// # Errors
    ///
    /// Fails on tenant mismatch, storage, or decode failure.
    pub fn delete_memory(
        &mut self,
        id: &str,
        scope: &RecallScope,
    ) -> Result<DeleteMemoryOutcome, MemoryEngineError> {
        let Some(memory) = self.get_memory(id, scope)? else {
            return Ok(DeleteMemoryOutcome {
                id: id.to_owned(),
                deleted: false,
            });
        };
        self.unindex_entities(&memory)?;
        self.delete_graph_memory_bindings(&memory.id, scope)?;
        self.hyphae
            .delete_vectors(Uuid::now_v7(), &memory_space(), &[memory.id.as_bytes()])?;
        self.hyphae
            .delete_record(Uuid::now_v7(), memory.id.as_bytes())?;
        Ok(DeleteMemoryOutcome {
            id: id.to_owned(),
            deleted: true,
        })
    }

    fn delete_graph_memory_bindings(
        &mut self,
        memory_id: &str,
        scope: &RecallScope,
    ) -> Result<(), MemoryEngineError> {
        let records = self.scan_prefix(GraphMemoryBinding::prefix())?;
        for record in records {
            let binding = GraphMemoryBinding::from_record(&record)?;
            if binding.memory_id == memory_id && graph_scope_visible(&binding.scope, scope) {
                self.hyphae.delete_record(Uuid::now_v7(), &record.key)?;
            }
        }
        Ok(())
    }

    /// Runs independent remember operations and returns every per-item result.
    pub fn remember_batch(&mut self, requests: Vec<RememberRequest>) -> Vec<BatchRememberOutcome> {
        requests
            .into_iter()
            .enumerate()
            .map(|(index, request)| BatchRememberOutcome {
                index,
                result: self.remember(request).map_err(|error| error.to_string()),
            })
            .collect()
    }

    fn semantic_candidates(
        &self,
        query: Q15Vector,
        limit: usize,
    ) -> Result<BranchCandidates, MemoryEngineError> {
        let outcome = self.hyphae.retrieve_exact(
            &ExactRetrievalRequest {
                vector_space: memory_space(),
                query,
                limit,
                minimum_score_nanos: CANDIDATE_SCORE_NANOS,
                minimum_margin_nanos: 0,
            },
            &ExactRetrievalLimits::default(),
        )?;
        Ok(match outcome {
            ExactRetrievalOutcome::Matches { matches, .. } => (
                matches
                    .into_iter()
                    // Cosine nanos map to the [0, 1] channel like the
                    // TS Qdrant scores: negatives carry no signal.
                    .map(|matched| {
                        (
                            matched.key,
                            (matched.score_nanos as f64 / 1e9).clamp(0.0, 1.0),
                        )
                    })
                    .collect(),
                None,
            ),
            ExactRetrievalOutcome::Abstained(abstention) => (
                Vec::new(),
                Some(match abstention.reason {
                    ExactAbstentionReason::NoCandidates => BranchAbstention::NoCandidates,
                    ExactAbstentionReason::BelowThreshold => BranchAbstention::BelowThreshold,
                    ExactAbstentionReason::Ambiguous => BranchAbstention::Ambiguous,
                }),
            ),
        })
    }

    fn lexical_candidates(
        &self,
        query_text: &str,
        limit: usize,
    ) -> Result<BranchCandidates, MemoryEngineError> {
        let outcome = self.hyphae.retrieve_lexical(
            &LexicalRequest {
                index: content_index(),
                query: query_text.to_owned(),
                limit,
            },
            &LexicalLimits::default(),
        )?;
        Ok(match outcome {
            LexicalOutcome::Matches { matches, .. } => {
                // BM25F is unbounded; the TS channel (pg_trgm) was
                // [0, 1]. Normalise by the best score so the top
                // lexical hit contributes 1.0 and the rest scale.
                let best = matches
                    .first()
                    .map_or(1.0, |matched| (matched.score_nanos as f64).max(1.0));
                (
                    matches
                        .into_iter()
                        .map(|matched| (matched.key, (matched.score_nanos as f64 / best).max(0.0)))
                        .collect(),
                    None,
                )
            }
            LexicalOutcome::Abstained(abstention) => (
                Vec::new(),
                Some(match abstention.reason {
                    LexicalAbstentionReason::NoCandidates => BranchAbstention::NoCandidates,
                }),
            ),
        })
    }

    fn load_memory(&self, key: &[u8]) -> Result<Memory, MemoryEngineError> {
        let record =
            self.hyphae
                .get_record(key)?
                .ok_or_else(|| MemoryEngineError::MissingCandidate {
                    id: String::from_utf8_lossy(key).into_owned(),
                })?;
        Ok(Memory::from_record(&record)?)
    }

    fn load_recall_candidate(&self, key: &[u8]) -> Result<Option<Memory>, MemoryEngineError> {
        let record =
            self.hyphae
                .get_record(key)?
                .ok_or_else(|| MemoryEngineError::MissingCandidate {
                    id: String::from_utf8_lossy(key).into_owned(),
                })?;
        let hyphae_query::Value::Object(fields) = &record.value else {
            return Ok(Some(Memory::from_record(&record)?));
        };
        if fields.get("kind")
            != Some(&hyphae_query::Value::String(
                crate::memory::MEMORY_KIND.to_owned(),
            ))
        {
            return Ok(None);
        }
        Ok(Some(Memory::from_record(&record)?))
    }

    /// Consolidates all visible events carrying one explicit turn ID into an episode.
    pub fn consolidate_turn(
        &mut self,
        request: ConsolidateTurnRequest,
    ) -> Result<DerivedMemory, MemoryEngineError> {
        let derived = self.build_turn_episode(&request)?;
        if let Some(existing) = self.get_derived(&derived.id, &request.scope)? {
            return Ok(existing);
        }
        self.hyphae
            .put_record(Uuid::now_v7(), &derived.to_record())?;
        Ok(derived)
    }

    /// Builds a strictly read-only consolidation plan.
    pub fn plan_consolidation(
        &self,
        request: ConsolidationPlanRequest,
    ) -> Result<ConsolidationPlan, MemoryEngineError> {
        let expected = self.build_turn_episode(&request.turn)?;
        let id = expected.id.to_string();
        Ok(ConsolidationPlan {
            id,
            turn: request.turn,
            actions: vec![ConsolidationAction::CreateDerived(expected.id.clone())],
            expected,
        })
    }

    /// Applies one deterministic plan and persists its run state.
    pub fn apply_consolidation(
        &mut self,
        plan: ConsolidationPlan,
    ) -> Result<ConsolidationRun, MemoryEngineError> {
        self.require_tenant(&plan.turn.scope.tenant_id)?;
        if let Some(record) = self.hyphae.get_record(&ConsolidationRun::key(&plan.id))? {
            let run = ConsolidationRun::from_record(&record)?;
            if !recall_scope_visible_to(&run.scope, &plan.turn.scope)
                || run.plan_digest.is_empty()
                || run.plan_digest != consolidation_plan_digest(&plan)
            {
                return Err(MemoryEngineError::ConsolidationPlanConflict);
            }
            return Ok(run);
        }
        let current = self.build_turn_episode(&plan.turn)?;
        let expected_actions = [ConsolidationAction::CreateDerived(current.id.clone())];
        if current != plan.expected
            || plan.id != current.id.to_string()
            || plan.actions.as_slice() != expected_actions
        {
            return Err(MemoryEngineError::ConsolidationPlanConflict);
        }
        let snapshot = self.hyphae.snapshot()?;
        let creates_derived = self
            .hyphae
            .get_record(&DerivedMemory::key(&plan.expected.id))?
            .is_none();
        let plan_digest = consolidation_plan_digest(&plan);
        let run = ConsolidationRun {
            id: plan.id,
            scope: plan.turn.scope,
            plan_digest,
            derived_ids: creates_derived
                .then(|| plan.expected.id.clone())
                .into_iter()
                .collect(),
            snapshot_sequence: snapshot.checkpoint_sequence,
            snapshot_digest: hex_digest(snapshot.snapshot_digest),
            status: ConsolidationRunStatus::Committed,
            recorded_at_ms: plan.expected.recorded_at_ms,
        };
        let mut records = Vec::with_capacity(2);
        if creates_derived {
            records.push(plan.expected.to_record());
        }
        records.push(run.to_record());
        self.hyphae.put_records(Uuid::now_v7(), &records)?;
        Ok(run)
    }

    /// Rolls back artifacts created by one run after verifying its pre-commit snapshot anchor.
    pub fn rollback_consolidation(
        &mut self,
        run_id: &str,
        scope: &RecallScope,
        _now_ms: i64,
    ) -> Result<RollbackReport, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let Some(record) = self.hyphae.get_record(&ConsolidationRun::key(run_id))? else {
            return Err(MemoryEngineError::ConsolidationSourcesEmpty);
        };
        let mut run = ConsolidationRun::from_record(&record)?;
        if !recall_scope_visible_to(&run.scope, scope) {
            return Err(MemoryEngineError::ConsolidationSourcesEmpty);
        }
        if run.status == ConsolidationRunStatus::RolledBack {
            return Ok(RollbackReport { rolled_back: 0 });
        }
        self.verify_consolidation_snapshot(&run)?;
        let mut rolled_back = 0;
        let rolled_back_ids: std::collections::BTreeSet<DerivedId> =
            run.derived_ids.iter().cloned().collect();
        for id in &run.derived_ids {
            if let Some(mut derived) = self.get_derived(id, scope)? {
                derived.status = crate::DerivedStatus::RolledBack;
                self.hyphae
                    .put_record(Uuid::now_v7(), &derived.to_record())?;
                rolled_back += 1;
            }
        }
        self.stale_derived_descendants(&rolled_back_ids, scope)?;
        run.status = ConsolidationRunStatus::RolledBack;
        self.hyphae.put_record(Uuid::now_v7(), &run.to_record())?;
        Ok(RollbackReport { rolled_back })
    }

    fn stale_derived_descendants(
        &mut self,
        roots: &std::collections::BTreeSet<DerivedId>,
        scope: &RecallScope,
    ) -> Result<(), MemoryEngineError> {
        let mut affected = roots.clone();
        loop {
            let mut changed = false;
            for mut entry in self.derived_memories(scope)? {
                if entry.status != crate::DerivedStatus::Active
                    || !entry.immediate_sources.iter().any(|source| {
                        matches!(source, DerivedSource::Derived(id) if affected.contains(id))
                    })
                {
                    continue;
                }
                entry.status = crate::DerivedStatus::Stale;
                changed |= affected.insert(entry.id.clone());
                self.hyphae.put_record(Uuid::now_v7(), &entry.to_record())?;
            }
            if !changed {
                break;
            }
        }
        Ok(())
    }

    fn verify_consolidation_snapshot(
        &self,
        run: &ConsolidationRun,
    ) -> Result<(), MemoryEngineError> {
        if run.snapshot_digest.is_empty() {
            return Err(MemoryEngineError::Snapshot {
                detail: "consolidation run has no pre-commit snapshot anchor".to_owned(),
            });
        }
        let point = crate::snapshot_points(self.hyphae.data_path())
            .map_err(|error| MemoryEngineError::Snapshot {
                detail: error.to_string(),
            })?
            .into_iter()
            .find(|point| point.checkpoint_sequence == run.snapshot_sequence)
            .ok_or_else(|| MemoryEngineError::Snapshot {
                detail: format!(
                    "consolidation snapshot {} is missing",
                    run.snapshot_sequence
                ),
            })?;
        let contents = hyphae_storage::load_snapshot(
            &point.path,
            &hyphae_storage::SnapshotReadLimits::default(),
        )
        .map_err(|error| MemoryEngineError::Snapshot {
            detail: error.to_string(),
        })?;
        let digest = hex_digest(contents.info.snapshot_digest);
        if digest != run.snapshot_digest {
            return Err(MemoryEngineError::Snapshot {
                detail: format!(
                    "consolidation snapshot {} digest does not match run anchor",
                    run.snapshot_sequence
                ),
            });
        }
        for id in &run.derived_ids {
            let key = DerivedMemory::key(id);
            if contents.entries.iter().any(|entry| entry.key == key) {
                return Err(MemoryEngineError::Snapshot {
                    detail: format!(
                        "consolidation snapshot {} already contains artifact {id}",
                        run.snapshot_sequence
                    ),
                });
            }
        }
        Ok(())
    }

    /// Creates or updates a durable schedule interpreted by an external clock.
    pub fn upsert_consolidation_schedule(
        &mut self,
        request: ConsolidationScheduleRequest,
    ) -> Result<ConsolidationSchedule, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_derived_text(&request.policy_version, "policy_version")?;
        let schedule = ConsolidationSchedule::from_request(request);
        self.hyphae
            .put_record(Uuid::now_v7(), &schedule.to_record())?;
        Ok(schedule)
    }

    /// Lists visible schedules due at or before an explicit clock.
    pub fn due_consolidations(
        &self,
        now_ms: i64,
        limit: usize,
        scope: &RecallScope,
    ) -> Result<Vec<ConsolidationSchedule>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let mut schedules = self
            .scan_prefix(ConsolidationSchedule::prefix())?
            .iter()
            .map(ConsolidationSchedule::from_record)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|schedule| recall_scope_visible_to(&schedule.scope, scope))
            .filter(|schedule| schedule.next_due_at_ms <= now_ms)
            .collect::<Vec<_>>();
        schedules.sort_by(|left, right| {
            left.next_due_at_ms
                .cmp(&right.next_due_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });
        schedules.truncate(limit.clamp(1, 1_000));
        Ok(schedules)
    }

    fn build_turn_episode(
        &self,
        request: &ConsolidateTurnRequest,
    ) -> Result<DerivedMemory, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_derived_text(&request.algorithm_version, "algorithm_version")?;
        let events = self
            .ingestion_entries(&request.scope)?
            .into_iter()
            .filter(|event| event.turn_id.as_ref() == Some(&request.turn_id))
            .collect::<Vec<_>>();
        let mut active_events = Vec::with_capacity(events.len());
        for event in events {
            if !self.is_derived_source_forgotten(&event.event_id, &request.scope)? {
                active_events.push(event);
            }
        }
        let mut events = active_events;
        if events.is_empty() {
            return Err(MemoryEngineError::ConsolidationSourcesEmpty);
        }
        events.sort_by(|left, right| {
            left.event_at_ms
                .unwrap_or(left.first_ingested_at_ms)
                .cmp(&right.event_at_ms.unwrap_or(right.first_ingested_at_ms))
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        let immediate_sources = events
            .iter()
            .map(|event| DerivedSource::Event(event.event_id.clone()))
            .collect::<Vec<_>>();
        let root_event_ids = events
            .iter()
            .map(|event| event.event_id.clone())
            .collect::<Vec<_>>();
        let root_hashes = events
            .iter()
            .map(|event| (event.event_id.clone(), event.content_hash.clone()))
            .collect::<Vec<_>>();
        let content = events
            .iter()
            .map(|event| format!("{}: {}", event.source_kind.as_str(), event.content.trim()))
            .collect::<Vec<_>>()
            .join("\n");
        let digest = source_digest(&immediate_sources, &root_hashes);
        Ok(DerivedMemory::build(NewDerivedMemory {
            kind: DerivedKind::Episode,
            scope: request.scope.clone(),
            hierarchy_key: request.turn_id.to_string(),
            content,
            immediate_sources,
            root_event_ids,
            source_digest: digest,
            algorithm_version: request.algorithm_version.clone(),
            recorded_at_ms: request.recorded_at_ms,
            period: None,
        }))
    }

    fn is_derived_source_forgotten(
        &self,
        event_id: &EventId,
        scope: &RecallScope,
    ) -> Result<bool, MemoryEngineError> {
        let Some(record) = self
            .hyphae
            .get_record(&ForgottenDerivedSource::key(event_id))?
        else {
            return Ok(false);
        };
        let forgotten = ForgottenDerivedSource::from_record(&record)?;
        Ok(ingestion_scope_visible_to(&forgotten.scope, scope))
    }

    fn count_active_derived_roots(
        &self,
        entry: &DerivedMemory,
    ) -> Result<usize, MemoryEngineError> {
        let mut active = 0;
        for event_id in &entry.root_event_ids {
            if !self.is_derived_source_forgotten(event_id, &entry.scope)? {
                active += 1;
            }
        }
        Ok(active)
    }

    /// Gets one visible derived artifact.
    pub fn get_derived(
        &self,
        derived_id: &DerivedId,
        scope: &RecallScope,
    ) -> Result<Option<DerivedMemory>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let Some(record) = self.hyphae.get_record(&DerivedMemory::key(derived_id))? else {
            return Ok(None);
        };
        let derived = DerivedMemory::from_record(&record)?;
        Ok(derived_visible_to(&derived.scope, scope).then_some(derived))
    }

    /// Lists visible derived artifacts in deterministic ID order.
    pub fn derived_memories(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<DerivedMemory>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let derived = self
            .scan_prefix(DerivedMemory::prefix())?
            .iter()
            .map(DerivedMemory::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(derived
            .into_iter()
            .filter(|entry| derived_visible_to(&entry.scope, scope))
            .collect())
    }

    fn derived_memories_for_summary(
        &self,
        scope: &RecallScope,
        target_kind: DerivedKind,
    ) -> Result<Vec<DerivedMemory>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let derived = self
            .scan_prefix(DerivedMemory::prefix())?
            .iter()
            .map(DerivedMemory::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(derived
            .into_iter()
            .filter(|entry| match target_kind {
                DerivedKind::SessionSummary => recall_scope_visible_to(&entry.scope, scope),
                DerivedKind::ProjectSummary | DerivedKind::PeriodSummary => {
                    entry.scope.tenant_id == scope.tenant_id
                        && entry.scope.user_id == scope.user_id
                        && entry.scope.project_id == scope.project_id
                }
                DerivedKind::Episode | DerivedKind::ClaimAggregate => false,
            })
            .collect())
    }

    /// Consolidates lower-level active derived artifacts into a hierarchy summary.
    pub fn consolidate_summary(
        &mut self,
        request: ConsolidateSummaryRequest,
    ) -> Result<DerivedMemory, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_derived_text(&request.hierarchy_key, "hierarchy_key")?;
        validate_derived_text(&request.algorithm_version, "algorithm_version")?;
        let period_window = match (&request.kind, &request.period) {
            (DerivedKind::PeriodSummary, Some(period)) if period.from_ms < period.to_ms => {
                Some(period.clone())
            }
            (DerivedKind::PeriodSummary, _) => return Err(InvalidDerived::Period.into()),
            (_, None) => None,
            (_, Some(_)) => return Err(InvalidDerived::Period.into()),
        };
        let source_kind = match request.kind {
            DerivedKind::SessionSummary => DerivedKind::Episode,
            DerivedKind::ProjectSummary => DerivedKind::SessionSummary,
            DerivedKind::PeriodSummary => DerivedKind::SessionSummary,
            DerivedKind::Episode | DerivedKind::ClaimAggregate => {
                return Err(InvalidDerived::Text {
                    field: "derived_kind",
                }
                .into());
            }
        };
        let mut sources = self
            .derived_memories_for_summary(&request.scope, request.kind)?
            .into_iter()
            .filter(|derived| derived.kind == source_kind)
            .filter(|derived| derived.status == crate::DerivedStatus::Active)
            .filter(|derived| {
                period_window.as_ref().is_none_or(|period| {
                    derived.recorded_at_ms >= period.from_ms
                        && derived.recorded_at_ms < period.to_ms
                })
            })
            .collect::<Vec<_>>();
        if sources.is_empty() {
            return Err(MemoryEngineError::ConsolidationSourcesEmpty);
        }
        sources.sort_by(|left, right| left.id.cmp(&right.id));
        let immediate_sources = sources
            .iter()
            .map(|source| DerivedSource::Derived(source.id.clone()))
            .collect::<Vec<_>>();
        let mut root_event_ids = sources
            .iter()
            .flat_map(|source| source.root_event_ids.clone())
            .collect::<Vec<_>>();
        root_event_ids.sort();
        root_event_ids.dedup();
        let mut root_hashes = Vec::with_capacity(root_event_ids.len());
        for event_id in &root_event_ids {
            let event = self
                .get_ingestion_for_hierarchy(event_id, &request.scope)?
                .ok_or_else(|| MemoryEngineError::IngestionEventNotFound {
                    event_id: event_id.to_string(),
                })?;
            root_hashes.push((event_id.clone(), event.content_hash));
        }
        let content = structured_summary(&sources);
        let target_scope = summary_target_scope(&request.scope, request.kind);
        let derived = DerivedMemory::build(NewDerivedMemory {
            kind: request.kind,
            scope: target_scope,
            hierarchy_key: request.hierarchy_key,
            content,
            immediate_sources: immediate_sources.clone(),
            root_event_ids,
            source_digest: source_digest(&immediate_sources, &root_hashes),
            algorithm_version: request.algorithm_version,
            recorded_at_ms: request.recorded_at_ms,
            period: period_window,
        });
        if let Some(existing) = self.get_derived(&derived.id, &request.scope)? {
            return Ok(existing);
        }
        self.hyphae
            .put_record(Uuid::now_v7(), &derived.to_record())?;
        Ok(derived)
    }

    fn get_ingestion_for_hierarchy(
        &self,
        event_id: &EventId,
        scope: &RecallScope,
    ) -> Result<Option<IngestionEntry>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        Ok(self
            .get_ingestion_unscoped(event_id)?
            .filter(|entry| ingestion_visible_to_derived_hierarchy(entry, scope)))
    }

    /// Consolidates compatible duplicate claims while preserving every member and root event.
    pub fn consolidate_claims(
        &mut self,
        request: ConsolidateClaimsRequest,
    ) -> Result<ClaimAggregate, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        validate_derived_text(&request.subject, "subject")?;
        validate_derived_text(&request.predicate, "predicate")?;
        validate_derived_text(&request.algorithm_version, "algorithm_version")?;
        let claims = self
            .visible_claims(&request.scope)?
            .into_iter()
            .filter(|claim| {
                claim.subject == request.subject && claim.predicate == request.predicate
            })
            .collect::<Vec<_>>();
        let mut active_evidence = BTreeMap::new();
        let mut active_claims = Vec::with_capacity(claims.len());
        for claim in claims {
            let evidence = self.active_claim_evidence(&claim.id, &request.scope)?;
            if !evidence.is_empty() {
                active_evidence.insert(claim.id.clone(), evidence);
                active_claims.push(claim);
            }
        }
        let mut claims = active_claims;
        if claims.is_empty() {
            return Err(MemoryEngineError::ConsolidationSourcesEmpty);
        }
        claims.sort_by(|left, right| left.id.cmp(&right.id));
        let contradictions = self.claim_contradictions(&request.scope)?;
        let member_ids: std::collections::BTreeSet<ClaimId> =
            claims.iter().map(|claim| claim.id.clone()).collect();
        let blocked = contradictions.iter().any(|contradiction| {
            member_ids.contains(&contradiction.left_claim_id)
                && member_ids.contains(&contradiction.right_claim_id)
        });
        let mut evidence_event_ids = Vec::new();
        let mut confidence_by_event: BTreeMap<EventId, i64> = BTreeMap::new();
        for claim in &claims {
            for evidence in &active_evidence[&claim.id] {
                evidence_event_ids.push(evidence.event_id.clone());
                confidence_by_event
                    .entry(evidence.event_id.clone())
                    .and_modify(|value| *value = (*value).max(claim.confidence_nanos))
                    .or_insert(claim.confidence_nanos);
            }
        }
        evidence_event_ids.sort();
        evidence_event_ids.dedup();
        let evidence_empty = evidence_event_ids.is_empty();
        let confidence_nanos = if blocked || evidence_empty {
            0
        } else {
            combine_confidence(confidence_by_event.values().copied())
        };
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"celiums-memory/claim-aggregate/v1");
        hash_plan_field(&mut hasher, b"subject", request.subject.as_bytes());
        hash_plan_field(&mut hasher, b"predicate", request.predicate.as_bytes());
        for claim in &claims {
            hash_plan_field(&mut hasher, b"claim_id", claim.id.as_str().as_bytes());
        }
        hash_plan_field(
            &mut hasher,
            b"algorithm_version",
            request.algorithm_version.as_bytes(),
        );
        let aggregate = ClaimAggregate {
            id: hasher.finalize().to_hex().to_string(),
            scope: request.scope.clone(),
            subject: request.subject,
            predicate: request.predicate,
            value: (!blocked && !evidence_empty).then(|| claims[0].value.clone()),
            member_claim_ids: claims.iter().map(|claim| claim.id.clone()).collect(),
            evidence_event_ids,
            confidence_nanos,
            status: if evidence_empty {
                ClaimAggregateStatus::Withdrawn
            } else if blocked {
                ClaimAggregateStatus::BlockedByContradiction
            } else {
                ClaimAggregateStatus::Active
            },
            algorithm_version: request.algorithm_version,
            recorded_at_ms: request.recorded_at_ms,
        };
        let key = format!("__celiums/claim_aggregate/{}", aggregate.id).into_bytes();
        if let Some(record) = self.hyphae.get_record(&key)? {
            return Ok(ClaimAggregate::from_record(&record)?);
        }
        self.hyphae
            .put_record(Uuid::now_v7(), &aggregate.to_record())?;
        Ok(aggregate)
    }

    /// Lists visible claim aggregates.
    pub fn claim_aggregates(
        &self,
        scope: &RecallScope,
    ) -> Result<Vec<ClaimAggregate>, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let aggregates = self
            .scan_prefix(ClaimAggregate::prefix())?
            .iter()
            .map(ClaimAggregate::from_record)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(aggregates
            .into_iter()
            .filter(|aggregate| recall_scope_visible_to(&aggregate.scope, scope))
            .collect())
    }

    /// Computes active-head redundancy and unique root evidence metrics.
    pub fn derived_metrics(
        &self,
        scope: &RecallScope,
    ) -> Result<DerivedMetrics, MemoryEngineError> {
        let active = self
            .derived_memories(scope)?
            .into_iter()
            .filter(|derived| derived.status == crate::DerivedStatus::Active)
            .collect::<Vec<_>>();
        let roots: std::collections::BTreeSet<EventId> = active
            .iter()
            .flat_map(|derived| derived.root_event_ids.clone())
            .collect();
        let active_heads = active
            .iter()
            .filter(|derived| {
                !active.iter().any(|other| {
                    other
                        .immediate_sources
                        .contains(&DerivedSource::Derived(derived.id.clone()))
                })
            })
            .count() as u64;
        let root_count = roots.len() as u64;
        let redundancy_ratio_nanos = active_heads
            .saturating_mul(1_000_000_000)
            .checked_div(root_count)
            .and_then(|value| i64::try_from(value).ok())
            .unwrap_or(0);
        Ok(DerivedMetrics {
            active_artifact_count: active.len() as u64,
            active_head_count: active_heads,
            root_evidence_count: root_count,
            redundancy_ratio_nanos,
        })
    }

    /// Propagates one forgotten root event through all visible descendants.
    pub fn forget_derived_source(
        &mut self,
        request: ForgetDerivedSourceRequest,
    ) -> Result<ForgetPropagationReport, MemoryEngineError> {
        self.require_tenant(&request.scope.tenant_id)?;
        let source = self
            .get_ingestion(&request.event_id, &request.scope)?
            .ok_or_else(|| MemoryEngineError::IngestionEventNotFound {
                event_id: request.event_id.to_string(),
            })?;
        let existing = self
            .hyphae
            .get_record(&ForgottenDerivedSource::key(&request.event_id))?
            .as_ref()
            .map(ForgottenDerivedSource::from_record)
            .transpose()?;
        let forgotten = ForgottenDerivedSource {
            scope: forgotten_source_scope(&source),
            event_id: request.event_id.clone(),
            mode: if request.mode == crate::ForgetMode::ErasurePending
                || existing
                    .as_ref()
                    .is_some_and(|entry| entry.mode == crate::ForgetMode::ErasurePending)
            {
                crate::ForgetMode::ErasurePending
            } else {
                crate::ForgetMode::SourceRetraction
            },
            recorded_at_ms: existing.as_ref().map_or(request.recorded_at_ms, |entry| {
                entry.recorded_at_ms.min(request.recorded_at_ms)
            }),
        };
        self.hyphae
            .put_record(Uuid::now_v7(), &forgotten.to_record())?;
        let mut affected = 0;
        let descendants = self
            .scan_prefix(DerivedMemory::prefix())?
            .iter()
            .map(DerivedMemory::from_record)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|entry| forgotten_source_reaches_derived(&forgotten.scope, &entry.scope))
            .collect::<Vec<_>>();
        for mut entry in descendants {
            if !entry.root_event_ids.contains(&request.event_id) {
                continue;
            }
            if forgotten.mode == crate::ForgetMode::ErasurePending {
                self.hyphae
                    .delete_record(Uuid::now_v7(), &DerivedMemory::key(&entry.id))?;
                affected += 1;
                continue;
            }
            let remaining_roots = self.count_active_derived_roots(&entry)?;
            let next_status = if remaining_roots == 0 {
                crate::DerivedStatus::Withdrawn
            } else {
                crate::DerivedStatus::Stale
            };
            let changed = entry.status != next_status;
            entry.status = next_status;
            self.hyphae.put_record(Uuid::now_v7(), &entry.to_record())?;
            affected += u64::from(changed);
        }
        let mut aggregates_affected = 0;
        let aggregates = self
            .scan_prefix(ClaimAggregate::prefix())?
            .iter()
            .map(ClaimAggregate::from_record)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|aggregate| ingestion_scope_visible_to(&forgotten.scope, &aggregate.scope))
            .collect::<Vec<_>>();
        for mut aggregate in aggregates {
            let has_active_evidence = aggregate.evidence_event_ids.contains(&request.event_id);
            let has_member_evidence = if forgotten.mode == crate::ForgetMode::ErasurePending {
                self.claim_aggregate_has_event(&aggregate, &request.event_id)?
            } else {
                false
            };
            if !has_active_evidence && !has_member_evidence {
                continue;
            }
            if forgotten.mode == crate::ForgetMode::ErasurePending {
                self.hyphae
                    .delete_record(Uuid::now_v7(), &ClaimAggregate::key(&aggregate.id))?;
                aggregates_affected += 1;
                continue;
            }
            aggregate
                .evidence_event_ids
                .retain(|id| id != &request.event_id);
            self.refresh_claim_aggregate(&mut aggregate)?;
            self.hyphae
                .put_record(Uuid::now_v7(), &aggregate.to_record())?;
            aggregates_affected += 1;
        }
        Ok(ForgetPropagationReport {
            affected,
            aggregates_affected,
        })
    }

    fn claim_aggregate_has_event(
        &self,
        aggregate: &ClaimAggregate,
        event_id: &EventId,
    ) -> Result<bool, MemoryEngineError> {
        for claim_id in &aggregate.member_claim_ids {
            if self
                .claim_evidence(claim_id, &aggregate.scope)?
                .iter()
                .any(|evidence| &evidence.event_id == event_id)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn refresh_claim_aggregate(
        &self,
        aggregate: &mut ClaimAggregate,
    ) -> Result<(), MemoryEngineError> {
        let active_events: std::collections::BTreeSet<EventId> =
            aggregate.evidence_event_ids.iter().cloned().collect();
        let mut confidence_by_event: BTreeMap<EventId, i64> = BTreeMap::new();
        let mut active_claims = Vec::new();
        for claim_id in &aggregate.member_claim_ids {
            let Some(claim) = self.get_claim(claim_id, &aggregate.scope)? else {
                continue;
            };
            let mut claim_is_active = false;
            for evidence in self.claim_evidence(claim_id, &aggregate.scope)? {
                if active_events.contains(&evidence.event_id) {
                    claim_is_active = true;
                    confidence_by_event
                        .entry(evidence.event_id)
                        .and_modify(|value| *value = (*value).max(claim.confidence_nanos))
                        .or_insert(claim.confidence_nanos);
                }
            }
            if claim_is_active {
                active_claims.push(claim);
            }
        }
        let active_ids: std::collections::BTreeSet<ClaimId> =
            active_claims.iter().map(|claim| claim.id.clone()).collect();
        let blocked = self
            .claim_contradictions(&aggregate.scope)?
            .iter()
            .any(|conflict| {
                active_ids.contains(&conflict.left_claim_id)
                    && active_ids.contains(&conflict.right_claim_id)
            });
        aggregate.status = if active_claims.is_empty() {
            ClaimAggregateStatus::Withdrawn
        } else if blocked {
            ClaimAggregateStatus::BlockedByContradiction
        } else {
            ClaimAggregateStatus::Active
        };
        aggregate.value = (aggregate.status == ClaimAggregateStatus::Active)
            .then(|| active_claims[0].value.clone());
        aggregate.confidence_nanos = if aggregate.status == ClaimAggregateStatus::Active {
            combine_confidence(confidence_by_event.values().copied())
        } else {
            0
        };
        Ok(())
    }

    /// Verifies immediate source references and root-event closure.
    pub fn verify_derived_lineage(
        &self,
        scope: &RecallScope,
    ) -> Result<DerivedIntegrityReport, MemoryEngineError> {
        self.require_tenant(&scope.tenant_id)?;
        let derived = self
            .scan_prefix(DerivedMemory::prefix())?
            .iter()
            .map(DerivedMemory::from_record)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|entry| derived_integrity_scope_visible(&entry.scope, scope))
            .collect::<Vec<_>>();
        let by_id: BTreeMap<DerivedId, &DerivedMemory> = derived
            .iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect();
        let mut issues = Vec::new();
        for entry in &derived {
            let mut expected_roots = std::collections::BTreeSet::new();
            for source in &entry.immediate_sources {
                match source {
                    DerivedSource::Event(event_id) => {
                        match self.get_ingestion_for_hierarchy(event_id, scope)? {
                            Some(_) => {
                                expected_roots.insert(event_id.clone());
                            }
                            None => push_derived_issue(
                                &mut issues,
                                "missing_immediate_source",
                                &entry.id,
                            ),
                        }
                    }
                    DerivedSource::Derived(derived_id) => match by_id.get(derived_id) {
                        Some(source) => {
                            expected_roots.extend(source.root_event_ids.iter().cloned());
                            if entry.status == crate::DerivedStatus::Active
                                && source.status != crate::DerivedStatus::Active
                            {
                                push_derived_issue(
                                    &mut issues,
                                    "inactive_immediate_source",
                                    &entry.id,
                                );
                            }
                        }
                        None => {
                            push_derived_issue(&mut issues, "missing_immediate_source", &entry.id)
                        }
                    },
                    DerivedSource::Claim(claim_id) => match self.get_claim(claim_id, scope)? {
                        Some(_) => {
                            for evidence in self.claim_evidence(claim_id, scope)? {
                                expected_roots.insert(evidence.event_id);
                            }
                        }
                        None => {
                            push_derived_issue(&mut issues, "missing_immediate_source", &entry.id)
                        }
                    },
                }
            }
            let actual_roots: std::collections::BTreeSet<EventId> =
                entry.root_event_ids.iter().cloned().collect();
            if expected_roots != actual_roots {
                push_derived_issue(&mut issues, "root_closure_mismatch", &entry.id);
            }
            let mut root_hashes = Vec::with_capacity(entry.root_event_ids.len());
            for root in &entry.root_event_ids {
                match self.get_ingestion_for_hierarchy(root, scope)? {
                    Some(event) => root_hashes.push((root.clone(), event.content_hash)),
                    None => push_derived_issue(&mut issues, "missing_root_event", &entry.id),
                }
            }
            if root_hashes.len() == entry.root_event_ids.len()
                && source_digest(&entry.immediate_sources, &root_hashes) != entry.source_digest
            {
                push_derived_issue(&mut issues, "source_digest_mismatch", &entry.id);
            }
            if derived_cycle_from(&entry.id, &by_id) {
                push_derived_issue(&mut issues, "derived_cycle", &entry.id);
            }
        }
        Ok(DerivedIntegrityReport {
            valid: issues.is_empty(),
            derived_count: derived.len(),
            issues,
        })
    }

    /// Consolidates a block of conversation text into memories
    /// (consolidate.ts:74-172).
    ///
    /// Lines above the noise floor are classified; each is either
    /// merged into a semantically-duplicate existing memory (cosine ≥
    /// 0.92) or stored as a new consolidated memory. Nothing is ever
    /// deleted.
    ///
    /// Two TS bugs are fixed deliberately (documented in the README):
    /// the merge takes `max(existing.importance, new_importance)` —
    /// the original used the *similarity score* — and
    /// `consolidation_count` increments instead of being set to 1.
    ///
    /// # Errors
    ///
    /// Fails on retrieval or storage failure.
    pub fn consolidate(
        &mut self,
        conversation_text: &str,
        now_ms: i64,
    ) -> Result<ConsolidationReport, MemoryEngineError> {
        let mut report = ConsolidationReport::default();
        let mut lines = Vec::new();
        for line in conversation_text.lines().map(str::trim) {
            if line.is_empty() {
                continue;
            }
            if line.chars().count() <= MIN_CONSOLIDATION_LINE_CHARS {
                report.skipped += 1;
            } else if lines.len() < MAX_LINES_PER_CONSOLIDATION {
                lines.push(line);
            }
        }

        for line in lines {
            let content = strip_speaker_prefix(line);
            let (importance, _signals) = classify_importance(content);
            if importance < MIN_CONSOLIDATION_IMPORTANCE {
                report.skipped += 1;
                continue;
            }

            let embedding =
                crate::embed::deterministic_embed(content, usize::from(self.dimension) as u16);
            if embedding.iter().all(|component| *component == 0.0) {
                report.skipped += 1;
                continue;
            }
            let vector = quantize(&embedding, self.dimension)?;
            let duplicate = self.find_duplicate(vector.clone())?;

            match duplicate {
                Some(existing_key) => {
                    let mut existing = self.load_memory(&existing_key)?;
                    existing.importance = existing.importance.max(importance);
                    existing.strength = CONSOLIDATION_STRENGTH;
                    existing.consolidation_count = existing.consolidation_count.saturating_add(1);
                    existing.state = MemoryState::Consolidated;
                    existing.last_retrieved_at_ms = now_ms;
                    self.hyphae
                        .put_record(Uuid::now_v7(), &existing.to_record())?;
                    report.merged += 1;
                }
                None => {
                    let memory = self.remember(RememberRequest {
                        content: content.to_owned(),
                        embedding,
                        tags: Vec::new(),
                        scope: Scope::Project,
                        importance: Some(importance),
                        now_ms,
                        context: None,
                        embedding_space: None,
                        idempotency_key: None,
                        content_role: celiums_cognition::ContentRole::Observation,
                        purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
                    })?;
                    // Consolidation-born memories start consolidated.
                    let mut consolidated = memory;
                    consolidated.state = MemoryState::Consolidated;
                    consolidated.consolidation_count = 1;
                    self.hyphae
                        .put_record(Uuid::now_v7(), &consolidated.to_record())?;
                    report.created += 1;
                }
            }
        }

        // Consolidation is the engine's nap (circadian.ts:352-356):
        // it pays down sleep debt and cognitive load.
        self.record_circadian_event(CircadianEvent::Consolidation, now_ms)?;
        Ok(report)
    }

    /// Applies lifecycle decay to every non-archived memory
    /// (lifecycle.ts:57-107): `importance *= 0.95^days_idle`, floored
    /// at 0.01, archived below 0.05.
    ///
    /// The TS engine declared this as a daily cron that never actually
    /// ran (method-name mismatch, dead code); here it is a real,
    /// callable maintenance operation.
    ///
    /// # Errors
    ///
    /// Fails on storage or decoding failure.
    pub fn run_lifecycle(&mut self, now_ms: i64) -> Result<LifecycleReport, MemoryEngineError> {
        let mut report = LifecycleReport::default();
        let memories = self.all_memories()?;
        for mut memory in memories {
            if memory.state == MemoryState::Archived {
                continue;
            }
            let days_idle = days_between(memory.last_retrieved_at_ms, now_ms);
            let decayed =
                retention::lifecycle_decay(memory.importance, days_idle).max(MIN_IMPORTANCE);
            let changed = (decayed - memory.importance).abs() > 1e-9;
            memory.importance = decayed;
            if decayed < retention::ARCHIVE_THRESHOLD {
                memory.state = MemoryState::Archived;
                report.archived += 1;
            } else if changed {
                report.decayed += 1;
            } else {
                continue;
            }
            self.hyphae
                .put_record(Uuid::now_v7(), &memory.to_record())?;
        }
        Ok(report)
    }

    fn find_duplicate(&self, vector: Q15Vector) -> Result<Option<Vec<u8>>, MemoryEngineError> {
        let outcome = self.hyphae.retrieve_exact(
            &ExactRetrievalRequest {
                vector_space: memory_space(),
                query: vector,
                limit: DEDUP_CANDIDATES,
                minimum_score_nanos: DEDUP_SCORE_NANOS,
                minimum_margin_nanos: 0,
            },
            &ExactRetrievalLimits::default(),
        )?;
        Ok(match outcome {
            ExactRetrievalOutcome::Matches { matches, .. } => {
                matches.into_iter().next().map(|matched| matched.key)
            }
            ExactRetrievalOutcome::Abstained(_) => None,
        })
    }

    fn all_memories(&self) -> Result<Vec<Memory>, MemoryEngineError> {
        use hyphae_query::{CompareOperator, ExecutionLimits, Filter, Query, Value};
        let mut memories = Vec::new();
        let mut cursor = None;
        loop {
            let result = self.hyphae.query(
                &Query {
                    filter: Filter::Compare {
                        path: FieldPath::field("kind"),
                        operator: CompareOperator::Equal,
                        value: Value::String(crate::memory::MEMORY_KIND.to_owned()),
                    },
                    sort: Vec::new(),
                    cursor,
                    limit: LIFECYCLE_BATCH,
                    aggregation: None,
                },
                &ExecutionLimits::default(),
            )?;
            for record in &result.rows {
                memories.push(Memory::from_record(record)?);
            }
            match result.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(memories)
    }

    /// Writes one journal entry, chained to the agent's previous entry.
    ///
    /// The chain hash covers `(id | agent_id | content | written_at |
    /// prev_hash)` — identical semantics to the TS journal, so
    /// [`Self::journal_verify_chain`] detects insertion, deletion and
    /// content tampering per entry.
    ///
    /// # Errors
    ///
    /// Fails on an invalid agent id (refused, never bucketed), a
    /// `preceded_by` reference to a nonexistent entry, or storage
    /// failure.
    pub fn journal_write(
        &mut self,
        request: JournalWriteRequest,
    ) -> Result<JournalEntry, MemoryEngineError> {
        let agent_id = validated_agent_id(&request.agent_id)?;
        for predecessor in &request.preceded_by {
            if self
                .hyphae
                .get_record(&entry_key(&agent_id, predecessor))?
                .is_none()
            {
                return Err(MemoryEngineError::JournalEntryNotFound {
                    agent_id,
                    entry_id: predecessor.clone(),
                });
            }
        }

        let prev_hash = self
            .last_journal_entry(&agent_id)?
            .map(|entry| entry.hash.clone());
        let id = Uuid::now_v7().to_string();
        let hash = chain_hash(
            &id,
            &agent_id,
            &request.content,
            request.now_ms,
            prev_hash.as_deref(),
        );
        let entry = JournalEntry {
            id,
            agent_id,
            entry_type: request.entry_type,
            content: request.content,
            preceded_by: request.preceded_by,
            valence: request.valence.map(|value| value.clamp(-1.0, 1.0)),
            valence_reason: request.valence_reason.map(|reason| {
                reason
                    .chars()
                    .take(MAX_VALENCE_REASON_CHARS)
                    .collect::<String>()
            }),
            importance: request.entry_type.importance(),
            tags: request.tags,
            conversation_id: request.conversation_id,
            written_at_ms: request.now_ms,
            prev_hash,
            hash,
        };
        self.hyphae.put_record(Uuid::now_v7(), &entry.to_record())?;
        Ok(entry)
    }

    /// Recalls one agent's journal entries, most recent first,
    /// filtered by type and (by default) excluding superseded entries.
    ///
    /// Retrieval is lexical (token overlap on the entry text) — the
    /// journal deliberately has no embedding requirement, so it works
    /// fully offline. An empty query returns the most recent entries.
    ///
    /// # Errors
    ///
    /// Fails on an invalid agent id or storage failure.
    pub fn journal_recall(
        &self,
        request: &JournalRecallRequest,
    ) -> Result<Vec<JournalEntry>, MemoryEngineError> {
        let agent_id = validated_agent_id(&request.agent_id)?;
        let mut entries = self.agent_journal_entries(&agent_id)?;

        if let Some(entry_type) = request.entry_type {
            entries.retain(|entry| entry.entry_type == entry_type);
        }
        if !request.include_superseded {
            let superseded = self.superseded_entry_ids(&agent_id)?;
            entries.retain(|entry| !superseded.contains(&entry.id));
        }

        // Newest first — the chain order reversed.
        entries.reverse();

        let query_tokens: Vec<String> = request
            .query
            .split_whitespace()
            .map(|token| token.to_lowercase())
            .collect();
        if !query_tokens.is_empty() {
            let mut scored: Vec<(usize, JournalEntry)> = entries
                .into_iter()
                .map(|entry| {
                    let haystack = entry.content.to_lowercase();
                    let hits = query_tokens
                        .iter()
                        .filter(|token| haystack.contains(*token))
                        .count();
                    (hits, entry)
                })
                .filter(|(hits, _)| *hits > 0)
                .collect();
            // Stable: ties keep recency order from the reverse above.
            scored.sort_by_key(|(hits, _)| std::cmp::Reverse(*hits));
            entries = scored.into_iter().map(|(_, entry)| entry).collect();
        }

        entries.truncate(request.limit.max(1));
        Ok(entries)
    }

    /// Records that `new_entry_id` supersedes `original_entry_id` for
    /// this agent. Superseded entries are excluded from recall by
    /// default; the entries themselves are never mutated (the chain
    /// stays intact).
    ///
    /// # Errors
    ///
    /// Fails when either entry does not exist for the agent.
    pub fn journal_supersede(
        &mut self,
        agent_id: &str,
        original_entry_id: &str,
        new_entry_id: &str,
        relation: SupersessionRelation,
        now_ms: i64,
    ) -> Result<Supersession, MemoryEngineError> {
        let agent_id = validated_agent_id(agent_id)?;
        for entry_id in [original_entry_id, new_entry_id] {
            if self
                .hyphae
                .get_record(&entry_key(&agent_id, entry_id))?
                .is_none()
            {
                return Err(MemoryEngineError::JournalEntryNotFound {
                    agent_id,
                    entry_id: entry_id.to_owned(),
                });
            }
        }
        let link = Supersession {
            id: Uuid::now_v7().to_string(),
            agent_id,
            original_entry_id: original_entry_id.to_owned(),
            new_entry_id: new_entry_id.to_owned(),
            relation,
            written_at_ms: now_ms,
        };
        self.hyphae.put_record(Uuid::now_v7(), &link.to_record())?;
        Ok(link)
    }

    /// Walks one agent's chain, recomputes every hash from scratch and
    /// reports broken links (journal-tools.ts:244-279 semantics: a
    /// `prev_hash` mismatch means insertion/deletion; a hash mismatch
    /// means content or timestamp tampering).
    ///
    /// # Errors
    ///
    /// Fails on an invalid agent id or storage failure.
    pub fn journal_verify_chain(&self, agent_id: &str) -> Result<ChainReport, MemoryEngineError> {
        let agent_id = validated_agent_id(agent_id)?;
        let entries = self.agent_journal_entries(&agent_id)?;

        let mut broken = Vec::new();
        let mut expected_prev: Option<String> = None;
        for entry in &entries {
            let computed = chain_hash(
                &entry.id,
                &entry.agent_id,
                &entry.content,
                entry.written_at_ms,
                expected_prev.as_deref(),
            );
            if entry.prev_hash != expected_prev {
                broken.push(BrokenLink {
                    entry_id: entry.id.clone(),
                    reason: BrokenReason::PrevHashMismatch,
                });
            } else if entry.hash != computed {
                broken.push(BrokenLink {
                    entry_id: entry.id.clone(),
                    reason: BrokenReason::ContentTampered,
                });
            }
            // Continue from the stored hash so cascades are visible
            // from the first break onward, like the TS verifier.
            expected_prev = Some(entry.hash.clone());
        }
        Ok(ChainReport {
            agent_id,
            total: entries.len() as u64,
            valid: broken.is_empty(),
            broken,
        })
    }

    /// One agent's entries in chain order (binary key order — UUIDv7
    /// ids sort chronologically).
    fn agent_journal_entries(
        &self,
        agent_id: &str,
    ) -> Result<Vec<JournalEntry>, MemoryEngineError> {
        let records = self.scan_prefix(&agent_prefix(agent_id))?;
        records
            .iter()
            .map(|record| JournalEntry::from_record(record).map_err(MemoryEngineError::from))
            .collect()
    }

    /// Entry ids of this agent that some link marks as superseded or
    /// recanted (nuanced/reaffirmed keep the original visible).
    fn superseded_entry_ids(
        &self,
        agent_id: &str,
    ) -> Result<std::collections::BTreeSet<String>, MemoryEngineError> {
        let records = self.scan_prefix(&supersession_prefix(agent_id))?;
        let mut ids = std::collections::BTreeSet::new();
        for record in &records {
            let link = Supersession::from_record(record)?;
            if matches!(
                link.relation,
                SupersessionRelation::Superseded | SupersessionRelation::Recanted
            ) {
                ids.insert(link.original_entry_id);
            }
        }
        Ok(ids)
    }

    fn last_journal_entry(
        &self,
        agent_id: &str,
    ) -> Result<Option<JournalEntry>, MemoryEngineError> {
        Ok(self.agent_journal_entries(agent_id)?.pop())
    }

    /// All records whose binary key starts with `prefix`, in key order.
    fn scan_prefix(&self, prefix: &[u8]) -> Result<Vec<hyphae_query::Record>, MemoryEngineError> {
        use hyphae_query::{ExecutionLimits, Filter, Query};
        // The record key is not a document field, so the prefix range
        // is walked by paging rows in binary-key order. Keys sharing a
        // prefix are contiguous in that order: the first key that is
        // greater than the prefix without carrying it marks the end of
        // the range.
        let mut records = Vec::new();
        let mut cursor = None;
        loop {
            let result = self.hyphae.query(
                &Query {
                    filter: Filter::MatchAll,
                    sort: Vec::new(),
                    cursor,
                    limit: 1_000,
                    aggregation: None,
                },
                &ExecutionLimits::default(),
            )?;
            let mut passed_range = false;
            for record in result.rows {
                if record.key.starts_with(prefix) {
                    records.push(record);
                } else if record.key.as_slice() > prefix {
                    passed_range = true;
                    break;
                }
            }
            match result.next_cursor {
                Some(next) if !passed_range => cursor = Some(next),
                _ => break,
            }
        }
        Ok(records)
    }

    /// Applies one limbic update (decayed to `now_ms` first) and
    /// persists the new state durably.
    ///
    /// The update runs on the RAW limbic state — the circadian
    /// modulation is applied only on read ([`Self::affect_state`]),
    /// never baked into the stored snapshot. Mixing them was the TS
    /// circadian-drift bug (`lastCircadianApplied` correction,
    /// limbic.ts:202-284): a state stored at night carried the night
    /// arousal into the next morning. Raw storage + fresh-on-read
    /// modulation makes the drift impossible by construction.
    fn update_affect(
        &mut self,
        input: Pad,
        recalled: &[MemoryInfluence],
        now_ms: i64,
    ) -> Result<(), MemoryEngineError> {
        let decayed = limbic::decay(
            self.affect.pad,
            &self.limbic_config,
            minutes_between(self.affect.updated_at_ms, now_ms),
        );
        let next = limbic::update(decayed, &self.limbic_config, input, recalled);
        self.affect = AffectState {
            pad: next,
            updated_at_ms: now_ms,
        };
        self.hyphae
            .put_record(Uuid::now_v7(), &self.affect.to_record())?;
        Ok(())
    }

    fn reactivate_top(
        &mut self,
        scored: &mut [ScoredMemory],
        now_ms: i64,
    ) -> Result<(), MemoryEngineError> {
        for entry in scored.iter_mut().take(REACTIVATION_TOP) {
            let outcome = retention::reactivate(
                entry.memory.importance,
                entry.memory.strength,
                entry.memory.retrieval_count,
            );
            entry.memory.importance = outcome.importance;
            entry.memory.strength = outcome.strength;
            entry.memory.retrieval_count = outcome.retrieval_count;
            entry.memory.state = MemoryState::Active;
            entry.memory.last_retrieved_at_ms = now_ms;
            self.hyphae
                .put_record(Uuid::now_v7(), &entry.memory.to_record())?;
        }
        Ok(())
    }
}

fn migrate_legacy_memories(
    hyphae: &mut HyphaeEngine,
    tenant_id: &TenantId,
    embedding_space: &EmbeddingSpaceIdentity,
) -> Result<(), MemoryEngineError> {
    use hyphae_query::{CompareOperator, Cursor, ExecutionLimits, Filter, Query, Value};
    let mut cursor: Option<Cursor> = None;
    loop {
        let result = hyphae.query(
            &Query {
                filter: Filter::Compare {
                    path: FieldPath::field("kind"),
                    operator: CompareOperator::Equal,
                    value: Value::String(crate::memory::MEMORY_KIND.to_owned()),
                },
                sort: Vec::new(),
                cursor,
                limit: LIFECYCLE_BATCH,
                aggregation: None,
            },
            &ExecutionLimits::default(),
        )?;
        let mut migrated = Vec::new();
        for record in &result.rows {
            let mut memory = Memory::from_record(record)?;
            if memory.schema_version >= 2
                && memory.embedding_space.is_some()
                && memory.governance.is_some()
            {
                continue;
            }
            memory.schema_version = 2;
            memory.identity.tenant_id = tenant_id.clone();
            memory.embedding_space = Some(embedding_space.clone());
            if memory.governance.is_none() {
                let evaluation = evaluate_ethics(&memory.content, None);
                memory.governance = Some(MemoryGovernance(classify_governance(
                    &memory.content,
                    SourceTrust::Unknown,
                    celiums_cognition::ContentRole::Description,
                    MemoryPurpose::SafetyAudit,
                    memory.created_at_ms,
                    &evaluation,
                )));
            }
            memory.updated_at_ms = memory.updated_at_ms.max(memory.created_at_ms);
            migrated.push(memory.to_record());
        }
        if !migrated.is_empty() {
            hyphae.put_records(Uuid::now_v7(), &migrated)?;
        }
        match result.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(())
}

/// Strips a leading `user:` / `assistant:` speaker prefix
/// (consolidate.ts:127).
fn strip_speaker_prefix(line: &str) -> &str {
    for prefix in ["user:", "assistant:", "User:", "Assistant:"] {
        if let Some(stripped) = line.strip_prefix(prefix) {
            return stripped.trim();
        }
    }
    line
}

fn validated_agent_id(candidate: &str) -> Result<String, MemoryEngineError> {
    let trimmed = candidate.trim();
    if is_valid_agent_id(trimmed) {
        Ok(trimmed.to_owned())
    } else {
        Err(MemoryEngineError::InvalidAgentId {
            agent_id: trimmed.chars().take(64).collect(),
        })
    }
}

pub(crate) fn memory_space() -> VectorSpaceName {
    VectorSpaceName::new(MEMORY_SPACE).unwrap_or_else(|_| unreachable!("static valid name"))
}

pub(crate) fn content_index() -> VectorSpaceName {
    VectorSpaceName::new(CONTENT_INDEX).unwrap_or_else(|_| unreachable!("static valid name"))
}

fn days_between(earlier_ms: i64, later_ms: i64) -> f64 {
    const MS_PER_DAY: f64 = 1000.0 * 60.0 * 60.0 * 24.0;
    #[allow(clippy::cast_precision_loss)]
    let elapsed = (later_ms.saturating_sub(earlier_ms)) as f64;
    f64::max(0.0, elapsed / MS_PER_DAY)
}

fn minutes_between(earlier_ms: i64, later_ms: i64) -> f64 {
    const MS_PER_MINUTE: f64 = 1000.0 * 60.0;
    #[allow(clippy::cast_precision_loss)]
    let elapsed = (later_ms.saturating_sub(earlier_ms)) as f64;
    f64::max(0.0, elapsed / MS_PER_MINUTE)
}

fn hours_between(earlier_ms: i64, later_ms: i64) -> f64 {
    minutes_between(earlier_ms, later_ms) / 60.0
}

fn scalar_nanos(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value * 1_000_000_000.0).round() as i64
    }
}

pub(crate) fn memory_visible_to(memory: &Memory, scope: &RecallScope) -> bool {
    if memory.identity.tenant_id != scope.tenant_id || memory.identity.user_id != scope.user_id {
        return false;
    }
    match memory.scope {
        Scope::Global => true,
        Scope::Project => memory.identity.project_id == scope.project_id,
        Scope::Session => {
            memory.identity.project_id == scope.project_id
                && memory.identity.session_id == scope.session_id
        }
    }
}

fn ingestion_visible_to(entry: &IngestionEntry, scope: &RecallScope) -> bool {
    if entry.identity.tenant_id != scope.tenant_id || entry.identity.user_id != scope.user_id {
        return false;
    }
    match entry.scope {
        Scope::Global => true,
        Scope::Project => entry.identity.project_id == scope.project_id,
        Scope::Session => {
            entry.identity.project_id == scope.project_id
                && entry.identity.session_id == scope.session_id
        }
    }
}

fn ingestion_visible_to_derived_hierarchy(entry: &IngestionEntry, scope: &RecallScope) -> bool {
    if entry.identity.tenant_id != scope.tenant_id || entry.identity.user_id != scope.user_id {
        return false;
    }
    match entry.scope {
        Scope::Global => true,
        Scope::Project | Scope::Session => entry.identity.project_id == scope.project_id,
    }
}

fn forgotten_source_scope(entry: &IngestionEntry) -> RecallScope {
    match entry.scope {
        Scope::Global => RecallScope {
            tenant_id: entry.identity.tenant_id.clone(),
            user_id: entry.identity.user_id.clone(),
            project_id: None,
            conversation_id: None,
            session_id: None,
        },
        Scope::Project => RecallScope {
            tenant_id: entry.identity.tenant_id.clone(),
            user_id: entry.identity.user_id.clone(),
            project_id: entry.identity.project_id.clone(),
            conversation_id: None,
            session_id: None,
        },
        Scope::Session => entry.scope(),
    }
}

fn ingestion_scope_visible_to(owner: &RecallScope, requested: &RecallScope) -> bool {
    owner.tenant_id == requested.tenant_id
        && owner.user_id == requested.user_id
        && owner
            .project_id
            .as_ref()
            .is_none_or(|project| requested.project_id.as_ref() == Some(project))
        && owner
            .session_id
            .as_ref()
            .is_none_or(|session| requested.session_id.as_ref() == Some(session))
}

fn forgotten_source_reaches_derived(source: &RecallScope, derived: &RecallScope) -> bool {
    source.tenant_id == derived.tenant_id
        && source.user_id == derived.user_id
        && source.project_id == derived.project_id
        && (source.session_id == derived.session_id || derived.session_id.is_none())
}

fn claim_visible_to(claim: &Claim, scope: &RecallScope) -> bool {
    recall_scope_visible_to(&claim.scope, scope)
}

fn resolution(mut entity_ids: Vec<EntityId>) -> EntityResolution {
    entity_ids.sort();
    entity_ids.dedup();
    match entity_ids.len() {
        0 => EntityResolution::NotFound,
        1 => EntityResolution::Resolved(entity_ids.remove(0)),
        _ => EntityResolution::Ambiguous(entity_ids),
    }
}

fn graph_path(
    seeds: &[EntityId],
    target: &EntityId,
    traversal: &GraphTraversalResult,
) -> Vec<EntityId> {
    if seeds.contains(target) {
        return vec![target.clone()];
    }
    let mut parent: BTreeMap<EntityId, EntityId> = BTreeMap::new();
    for edge in &traversal.edges {
        parent
            .entry(edge.relation.target_entity_id.clone())
            .or_insert_with(|| edge.relation.source_entity_id.clone());
        if edge.relation.direction == RelationDirection::Undirected {
            parent
                .entry(edge.relation.source_entity_id.clone())
                .or_insert_with(|| edge.relation.target_entity_id.clone());
        }
    }
    let mut path = vec![target.clone()];
    let mut current = target;
    while let Some(previous) = parent.get(current) {
        path.push(previous.clone());
        if seeds.contains(previous) {
            break;
        }
        current = previous;
    }
    path.reverse();
    path
}

fn graph_candidate_channels(memory: &Memory, now_ms: i64) -> ChannelScores {
    ChannelScores {
        semantic: 0.0,
        text_match: 0.0,
        importance: memory.importance,
        retrievability: retrievability(
            days_between(memory.last_retrieved_at_ms, now_ms),
            memory.strength,
        ),
        emotional: emotional_weight(memory.pad.pleasure, memory.pad.arousal),
        resonance: 0.5,
    }
}

fn structured_summary(sources: &[DerivedMemory]) -> String {
    let mut done = Vec::new();
    let mut open = Vec::new();
    let mut next = Vec::new();
    for source in sources {
        for line in source.content.lines().map(str::trim) {
            let lower = line.to_lowercase();
            if lower.contains("open:") || lower.contains("failed") || lower.contains("error") {
                open.push(line.to_owned());
            } else if lower.contains("next:") || lower.contains("todo") {
                next.push(line.to_owned());
            } else {
                done.push(line.to_owned());
            }
        }
    }
    format!(
        "DONE\n{}\nOPEN\n{}\nNEXT\n{}",
        done.join("\n"),
        open.join("\n"),
        next.join("\n")
    )
}

fn combine_confidence(confidences: impl IntoIterator<Item = i64>) -> i64 {
    const SCALE: i128 = 1_000_000_000;
    let mut remaining = SCALE;
    for confidence in confidences {
        let confidence = i128::from(confidence.clamp(0, SCALE as i64));
        remaining = remaining.saturating_mul(SCALE - confidence) / SCALE;
    }
    i64::try_from(SCALE - remaining).unwrap_or(1_000_000_000)
}

fn push_derived_issue(issues: &mut Vec<DerivedIntegrityIssue>, kind: &str, derived_id: &DerivedId) {
    issues.push(DerivedIntegrityIssue {
        kind: kind.to_owned(),
        derived_id: derived_id.to_string(),
    });
}

fn derived_cycle_from(start: &DerivedId, by_id: &BTreeMap<DerivedId, &DerivedMemory>) -> bool {
    let mut stack = vec![start.clone()];
    let mut visited = std::collections::BTreeSet::new();
    while let Some(current) = stack.pop() {
        let Some(entry) = by_id.get(&current) else {
            continue;
        };
        for source in &entry.immediate_sources {
            let DerivedSource::Derived(source_id) = source else {
                continue;
            };
            if source_id == start {
                return true;
            }
            if visited.insert(source_id.clone()) {
                stack.push(source_id.clone());
            }
        }
    }
    false
}

fn consolidation_plan_digest(plan: &ConsolidationPlan) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/consolidation-plan/v1");
    hash_plan_field(&mut hasher, b"id", plan.id.as_bytes());
    hash_plan_field(
        &mut hasher,
        b"tenant_id",
        plan.turn.scope.tenant_id.as_str().as_bytes(),
    );
    hash_plan_field(
        &mut hasher,
        b"user_id",
        plan.turn.scope.user_id.as_str().as_bytes(),
    );
    hash_optional_plan_field(
        &mut hasher,
        b"project_id",
        plan.turn
            .scope
            .project_id
            .as_ref()
            .map(crate::ProjectId::as_str),
    );
    hash_optional_plan_field(
        &mut hasher,
        b"conversation_id",
        plan.turn
            .scope
            .conversation_id
            .as_ref()
            .map(crate::ConversationId::as_str),
    );
    hash_optional_plan_field(
        &mut hasher,
        b"session_id",
        plan.turn
            .scope
            .session_id
            .as_ref()
            .map(crate::SessionId::as_str),
    );
    hash_plan_field(
        &mut hasher,
        b"turn_id",
        plan.turn.turn_id.as_str().as_bytes(),
    );
    hash_plan_field(
        &mut hasher,
        b"algorithm_version",
        plan.turn.algorithm_version.as_bytes(),
    );
    hash_plan_field(
        &mut hasher,
        b"recorded_at_ms",
        &plan.turn.recorded_at_ms.to_le_bytes(),
    );
    hash_plan_field(
        &mut hasher,
        b"expected_derived_id",
        plan.expected.id.as_str().as_bytes(),
    );
    hash_plan_field(
        &mut hasher,
        b"expected_source_digest",
        plan.expected.source_digest.as_bytes(),
    );
    for action in &plan.actions {
        match action {
            ConsolidationAction::CreateDerived(id) => {
                hash_plan_field(&mut hasher, b"create_derived", id.as_str().as_bytes());
            }
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn hash_plan_field(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn hash_optional_plan_field(hasher: &mut blake3::Hasher, name: &[u8], value: Option<&str>) {
    match value {
        Some(value) => {
            hash_plan_field(hasher, name, &[1]);
            hash_plan_field(hasher, name, value.as_bytes());
        }
        None => hash_plan_field(hasher, name, &[0]),
    }
}

fn recall_scope_visible_to(owner: &RecallScope, requested: &RecallScope) -> bool {
    owner.tenant_id == requested.tenant_id
        && owner.user_id == requested.user_id
        && owner.project_id == requested.project_id
        && owner.session_id == requested.session_id
}

fn derived_visible_to(owner: &RecallScope, requested: &RecallScope) -> bool {
    owner.tenant_id == requested.tenant_id
        && owner.user_id == requested.user_id
        && owner
            .project_id
            .as_ref()
            .is_none_or(|project| requested.project_id.as_ref() == Some(project))
        && owner
            .session_id
            .as_ref()
            .is_none_or(|session| requested.session_id.as_ref() == Some(session))
}

fn derived_integrity_scope_visible(owner: &RecallScope, requested: &RecallScope) -> bool {
    owner.tenant_id == requested.tenant_id
        && owner.user_id == requested.user_id
        && owner.project_id == requested.project_id
}

fn summary_target_scope(scope: &RecallScope, kind: DerivedKind) -> RecallScope {
    match kind {
        DerivedKind::SessionSummary => scope.clone(),
        DerivedKind::ProjectSummary | DerivedKind::PeriodSummary => RecallScope {
            tenant_id: scope.tenant_id.clone(),
            user_id: scope.user_id.clone(),
            project_id: scope.project_id.clone(),
            conversation_id: None,
            session_id: None,
        },
        DerivedKind::Episode | DerivedKind::ClaimAggregate => scope.clone(),
    }
}

fn hex_digest(digest: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

pub(crate) fn disclose_memory(
    memory: &Memory,
    authority: celiums_cognition::DisclosureAuthority,
    purpose: MemoryPurpose,
) -> (celiums_cognition::DisclosureClass, Option<String>) {
    use celiums_cognition::DisclosureClass;
    let Some(governance) = &memory.governance else {
        return (
            DisclosureClass::Restrict,
            Some(celiums_cognition::RESTRICTED_SUMMARY.to_owned()),
        );
    };
    let decision =
        celiums_cognition::disclosure_decision(governance.0.treatment, authority, purpose);
    let content = match decision.class {
        DisclosureClass::Include => Some(memory.content.clone()),
        DisclosureClass::Redact => Some(celiums_cognition::redact(
            &memory.content,
            &governance.0.trace.redaction_spans,
        )),
        DisclosureClass::Summarize | DisclosureClass::Restrict => decision.summary,
        DisclosureClass::Abstain => None,
    };
    (decision.class, content)
}

fn source_trust(context: Option<&RememberContext>) -> SourceTrust {
    match context.map(|context| context.provenance.source_kind) {
        Some(crate::SourceKind::User) => SourceTrust::UserProvided,
        Some(crate::SourceKind::System) => SourceTrust::Trusted,
        Some(
            crate::SourceKind::Assistant
            | crate::SourceKind::Tool
            | crate::SourceKind::Document
            | crate::SourceKind::Benchmark
            | crate::SourceKind::Legacy,
        ) => SourceTrust::External,
        None => SourceTrust::UserProvided,
    }
}

fn canonical_ingest_event_hash(request: &IngestEventRequest) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/ingestion-event-request/v1");
    hash_ingest_source(&mut hasher, request);
    hash_ingest_identity(&mut hasher, &request.identity);
    hash_ingest_payload(&mut hasher, request);
    hasher.finalize().to_hex().to_string()
}

fn batch_scope(events: &[IngestEventRequest]) -> Result<RecallScope, MemoryEngineError> {
    let first = events
        .first()
        .ok_or(MemoryEngineError::InvalidIngestionBatch {
            detail: "at least one event is required",
        })?;
    let scope = RecallScope {
        tenant_id: first.identity.tenant_id.clone(),
        user_id: first.identity.user_id.clone(),
        project_id: first.identity.project_id.clone(),
        conversation_id: first.identity.conversation_id.clone(),
        session_id: first.identity.session_id.clone(),
    };
    if events.iter().any(|event| {
        event.identity.tenant_id != scope.tenant_id || event.identity.user_id != scope.user_id
    }) {
        return Err(MemoryEngineError::InvalidIngestionBatch {
            detail: "all events must share tenant and user",
        });
    }
    Ok(scope)
}

fn new_ingestion_entry(
    request: &IngestEventRequest,
    event_id: EventId,
    request_hash: String,
) -> IngestionEntry {
    IngestionEntry {
        event_id,
        source_namespace: request.source_namespace.clone(),
        source_event_id: request.source_event_id.clone(),
        turn_id: request.turn_id.clone(),
        identity: request.identity.clone(),
        source_kind: request.source_kind,
        source_uri: request.source_uri.clone(),
        actor: request.actor.clone(),
        content: request.content.clone(),
        tags: request.tags.clone(),
        scope: request.scope,
        importance_nanos: request.importance.map(scalar_nanos),
        content_role: request.content_role,
        purpose: request.purpose,
        content_hash: blake3::hash(request.content.as_bytes())
            .to_hex()
            .to_string(),
        request_hash,
        event_at_ms: request.event_at_ms,
        first_ingested_at_ms: request.ingested_at_ms,
        last_attempted_at_ms: request.ingested_at_ms,
        attempt_count: 1,
        conflict_count: 0,
        status: IngestionStatus::Received,
        memory_id: None,
        error_code: None,
        enrichment_provider: None,
        enrichment_attempt_count: 0,
    }
}

fn canonical_batch_hash(events: &[IngestEventRequest]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/ingestion-batch/v1");
    for event in events {
        write_ingest_hash_field(
            &mut hasher,
            b"event_request_hash",
            canonical_ingest_event_hash(event).as_bytes(),
        );
    }
    hasher.finalize().to_hex().to_string()
}

fn hash_ingest_source(hasher: &mut blake3::Hasher, request: &IngestEventRequest) {
    write_ingest_hash_field(
        hasher,
        b"source_namespace",
        request.source_namespace.as_str().as_bytes(),
    );
    write_ingest_hash_field(
        hasher,
        b"source_event_id",
        request.source_event_id.as_str().as_bytes(),
    );
    write_optional_ingest_text(
        hasher,
        b"turn_id",
        request.turn_id.as_ref().map(TurnId::as_str),
    );
    write_ingest_hash_field(
        hasher,
        b"source_kind",
        request.source_kind.as_str().as_bytes(),
    );
    write_optional_ingest_text(hasher, b"source_uri", request.source_uri.as_deref());
    write_optional_ingest_text(hasher, b"actor", request.actor.as_deref());
}

fn hash_ingest_identity(hasher: &mut blake3::Hasher, identity: &crate::MemoryIdentity) {
    write_ingest_hash_field(hasher, b"tenant_id", identity.tenant_id.as_str().as_bytes());
    write_ingest_hash_field(hasher, b"user_id", identity.user_id.as_str().as_bytes());
    write_optional_ingest_text(
        hasher,
        b"agent_id",
        identity.agent_id.as_ref().map(crate::AgentId::as_str),
    );
    write_optional_ingest_text(
        hasher,
        b"project_id",
        identity.project_id.as_ref().map(crate::ProjectId::as_str),
    );
    write_optional_ingest_text(
        hasher,
        b"conversation_id",
        identity
            .conversation_id
            .as_ref()
            .map(crate::ConversationId::as_str),
    );
    write_optional_ingest_text(
        hasher,
        b"session_id",
        identity.session_id.as_ref().map(crate::SessionId::as_str),
    );
}

fn hash_ingest_payload(hasher: &mut blake3::Hasher, request: &IngestEventRequest) {
    write_ingest_hash_field(hasher, b"content", request.content.as_bytes());
    write_optional_ingest_i64(hasher, b"event_at_ms", request.event_at_ms);
    write_ingest_hash_field(hasher, b"scope", request.scope.as_str().as_bytes());
    for tag in &request.tags {
        write_ingest_hash_field(hasher, b"tag", tag.as_bytes());
    }
    write_ingest_hash_field(
        hasher,
        b"importance",
        &request
            .importance
            .unwrap_or(f64::NAN)
            .to_bits()
            .to_le_bytes(),
    );
    write_ingest_hash_field(
        hasher,
        b"content_role",
        content_role_name(request.content_role).as_bytes(),
    );
    write_ingest_hash_field(hasher, b"purpose", purpose_name(request.purpose).as_bytes());
}

fn write_optional_ingest_text(hasher: &mut blake3::Hasher, name: &[u8], value: Option<&str>) {
    match value {
        Some(value) => {
            write_ingest_hash_field(hasher, name, &[1]);
            write_ingest_hash_field(hasher, name, value.as_bytes());
        }
        None => write_ingest_hash_field(hasher, name, &[0]),
    }
}

fn write_optional_ingest_i64(hasher: &mut blake3::Hasher, name: &[u8], value: Option<i64>) {
    match value {
        Some(value) => {
            write_ingest_hash_field(hasher, name, &[1]);
            write_ingest_hash_field(hasher, name, &value.to_le_bytes());
        }
        None => write_ingest_hash_field(hasher, name, &[0]),
    }
}

fn write_ingest_hash_field(hasher: &mut blake3::Hasher, name: &[u8], value: &[u8]) {
    hasher.update(&(name.len() as u64).to_le_bytes());
    hasher.update(name);
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn content_role_name(role: celiums_cognition::ContentRole) -> &'static str {
    match role {
        celiums_cognition::ContentRole::Observation => "observation",
        celiums_cognition::ContentRole::Description => "description",
        celiums_cognition::ContentRole::OperationalRequest => "operational_request",
    }
}

fn ingestion_error_code(error: &MemoryEngineError) -> &'static str {
    match error {
        MemoryEngineError::Quantize(_) => "invalid_embedding",
        MemoryEngineError::EmbeddingSpaceMismatch { .. } => "embedding_space_mismatch",
        MemoryEngineError::TenantMismatch { .. } => "tenant_mismatch",
        MemoryEngineError::ContentHashMismatch => "content_hash_mismatch",
        MemoryEngineError::IdempotencyConflict => "idempotency_conflict",
        _ => "materialization_failed",
    }
}

fn deterministic_ingestion_uuid(entry: &IngestionEntry) -> Uuid {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/ingestion-ledger-write/v1");
    hasher.update(entry.event_id.as_str().as_bytes());
    hasher.update(&entry.attempt_count.to_le_bytes());
    hasher.update(&entry.conflict_count.to_le_bytes());
    hasher.update(&entry.enrichment_attempt_count.to_le_bytes());
    hasher.update(&entry.last_attempted_at_ms.to_le_bytes());
    hasher.update(entry.status.as_str().as_bytes());
    if let Some(provider) = &entry.enrichment_provider {
        hasher.update(provider.as_bytes());
    }
    if let Some(memory_id) = &entry.memory_id {
        hasher.update(memory_id.as_bytes());
    }
    if let Some(error_code) = &entry.error_code {
        hasher.update(error_code.as_bytes());
    }
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn deterministic_claim_uuid(claim_id: &ClaimId, phase: &str) -> Uuid {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/claim-write/v1");
    hasher.update(claim_id.as_str().as_bytes());
    hasher.update(&[0]);
    hasher.update(phase.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn treatment_name(treatment: Treatment) -> &'static str {
    match treatment {
        Treatment::Normal => "normal",
        Treatment::Sensitive => "sensitive",
        Treatment::Restricted => "restricted",
        Treatment::Quarantined => "quarantined",
    }
}

fn purpose_name(purpose: MemoryPurpose) -> &'static str {
    match purpose {
        MemoryPurpose::ConversationalContext => "conversational_context",
        MemoryPurpose::Personalization => "personalization",
        MemoryPurpose::TaskExecution => "task_execution",
        MemoryPurpose::SafetyAudit => "safety_audit",
    }
}

fn audit_decision_for_enforcement(
    decision: celiums_cognition::EnforcementDecision,
) -> AuditDecision {
    match decision {
        celiums_cognition::EnforcementDecision::Allow => AuditDecision::Allow,
        celiums_cognition::EnforcementDecision::AllowRestricted => AuditDecision::Restrict,
        celiums_cognition::EnforcementDecision::Reject => AuditDecision::Reject,
        celiums_cognition::EnforcementDecision::Quarantine => AuditDecision::Quarantine,
    }
}

fn governance_reason_codes(
    governance: &celiums_cognition::GovernanceClassification,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if governance.trace.ethics_enforcement_blocked {
        reasons.push("ethics_enforcement".to_owned());
    }
    if governance.poisoning_risk != celiums_cognition::PoisoningRisk::None {
        reasons.push("memory_poisoning".to_owned());
    }
    if !governance.trace.pii.is_empty() {
        reasons.push("pii".to_owned());
    }
    if !governance.trace.secrets.is_empty() {
        reasons.push("secret".to_owned());
    }
    reasons
}

fn validate_scope_identity(
    scope: Scope,
    identity: &crate::MemoryIdentity,
) -> Result<(), MemoryEngineError> {
    let valid = match scope {
        Scope::Global => true,
        Scope::Project => identity.project_id.is_some(),
        Scope::Session => identity.project_id.is_some() && identity.session_id.is_some(),
    };
    if valid {
        Ok(())
    } else {
        Err(MemoryEngineError::Decode(MemoryDecodeError::Field {
            field: "scope_identity",
        }))
    }
}

fn ensure_embedding_space(
    expected: &EmbeddingSpaceIdentity,
    received: &EmbeddingSpaceIdentity,
) -> Result<(), MemoryEngineError> {
    if expected == received {
        return Ok(());
    }
    Err(MemoryEngineError::EmbeddingSpaceMismatch {
        expected: embedding_space_label(expected),
        received: embedding_space_label(received),
    })
}

fn embedding_space_label(space: &EmbeddingSpaceIdentity) -> String {
    format!(
        "{}/{}/{}:{}:{}",
        space.provider,
        space.model,
        space.revision,
        space.dimension,
        space.normalization.as_str()
    )
}

fn deterministic_phase_uuid(tenant: &TenantId, key: &IdempotencyKey, phase: &str) -> Uuid {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory/remember-phase/v1");
    hasher.update(tenant.as_str().as_bytes());
    hasher.update(&[0]);
    hasher.update(key.as_str().as_bytes());
    hasher.update(&[0]);
    hasher.update(phase.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest.as_bytes()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

/// UTC hour-of-day (0-23.99…) of a Unix-milliseconds timestamp.
fn utc_hour(now_ms: i64) -> f64 {
    const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;
    const MS_PER_HOUR: f64 = 60.0 * 60.0 * 1000.0;
    #[allow(clippy::cast_precision_loss)]
    let in_day = (now_ms.rem_euclid(MS_PER_DAY)) as f64;
    in_day / MS_PER_HOUR
}
