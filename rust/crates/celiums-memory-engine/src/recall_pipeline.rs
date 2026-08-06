// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Public Phase 7 recall, compact search, hydration and context contracts.

use std::collections::BTreeMap;

use celiums_cognition::{DisclosureAuthority, DisclosureClass, MemoryPurpose, Pad};

use crate::{EntityId, MemoryFilter, RecallScope};

/// Policy-safe metadata returned by recall.
#[derive(Clone, Debug, PartialEq)]
pub struct RecalledMemory {
    /// Memory ID.
    pub id: String,
    /// Governed content.
    pub content: String,
    /// Importance used by cognitive scoring.
    pub importance: f64,
    /// Memory classification.
    pub memory_type: celiums_cognition::MemoryType,
    /// Lifecycle state.
    pub state: celiums_cognition::MemoryState,
    /// Visibility scope.
    pub scope: celiums_cognition::Scope,
    /// Source event clock.
    pub event_at_ms: Option<i64>,
    /// Ingestion clock.
    pub ingested_at_ms: i64,
    /// Retrieval count exposed for read-only continuity checks.
    pub retrieval_count: u32,
    /// Ebbinghaus strength used by scoring.
    pub strength: f64,
    /// Last recall clock used by retrievability.
    pub last_retrieved_at_ms: i64,
    /// Number of semantic consolidation merges.
    pub consolidation_count: u32,
    /// Safe tags omitted until tag governance exists.
    pub tags: Vec<String>,
    /// Internal vector retained for MMR but not exported by transports.
    pub(crate) vector: Option<hyphae_core::Q15Vector>,
}

/// Branches contributing candidates to one bounded recall union.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SearchBranch {
    /// Exact Q15 cosine retrieval.
    Semantic,
    /// BM25F retrieval.
    Lexical,
    /// Bounded context-graph traversal.
    Graph,
    /// Current bitemporal claim evidence.
    Temporal,
}

/// Enabled branches and graph traversal budgets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecallBranchOptions {
    /// Enable exact semantic retrieval.
    pub semantic: bool,
    /// Enable BM25F retrieval.
    pub lexical: bool,
    /// Enable graph candidate generation.
    pub graph: bool,
    /// Enable current-claim candidate generation.
    pub temporal: bool,
    /// Graph depth budget.
    pub graph_max_depth: usize,
    /// Graph edge budget.
    pub graph_max_edges: usize,
    /// Graph entity budget.
    pub graph_max_entities: usize,
    /// Graph-derived memory budget.
    pub graph_max_memories: usize,
    /// Current-claim memory budget.
    pub temporal_max_memories: usize,
    /// Strict unique-candidate union budget.
    pub max_union_candidates: usize,
}

impl Default for RecallBranchOptions {
    fn default() -> Self {
        Self {
            semantic: true,
            lexical: true,
            graph: true,
            temporal: true,
            graph_max_depth: 2,
            graph_max_edges: 100,
            graph_max_entities: 100,
            graph_max_memories: 100,
            temporal_max_memories: 100,
            max_union_candidates: 1_000,
        }
    }
}

/// Diversity policy applied after scoring and exact-content deduplication.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DiversityOptions {
    /// MMR relevance weight in `[0, 1]`.
    pub relevance_weight: f64,
}

impl Default for DiversityOptions {
    fn default() -> Self {
        Self {
            relevance_weight: 0.75,
        }
    }
}

/// Stable identity of an optional external cross-encoder.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RerankerIdentity {
    /// Provider or runtime.
    pub provider: String,
    /// Model name.
    pub model: String,
    /// Immutable model revision.
    pub revision: String,
}

/// Provider-neutral external reranker scores in deterministic nanos.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExternalRerankerScores {
    /// Model identity.
    pub identity: RerankerIdentity,
    /// Memory-ID to score map; each value must be in `0..=1e9`.
    pub scores_nanos: BTreeMap<String, i64>,
}

/// Optional reranking input. Provider calls remain outside the engine.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum RerankerInput {
    /// No external reranker was supplied.
    #[default]
    Deterministic,
    /// Apply caller-supplied cross-encoder scores.
    External(ExternalRerankerScores),
    /// The caller attempted a model but it was unavailable.
    Unavailable(RerankerIdentity),
}

/// Reranking path actually used for one response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RerankerStatus {
    /// Cognitive scoring was the deterministic fallback.
    DeterministicFallback,
    /// External scores were applied.
    ExternalApplied(RerankerIdentity),
    /// External execution failed and deterministic scoring remained active.
    ExternalUnavailableFallback(RerankerIdentity),
}

/// Optional controls for the Phase 7 recall pipeline.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecallOptions {
    /// Caller filter combined with non-bypassable authorization.
    pub filter: Option<MemoryFilter>,
    /// Candidate branches and their budgets.
    pub branches: RecallBranchOptions,
    /// Diversity policy.
    pub diversity: DiversityOptions,
    /// Optional provider-neutral reranker input.
    pub reranker: RerankerInput,
}

/// A read-only recall query.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallRequest {
    /// Query text driving lexical, graph and temporal branches.
    pub query_text: String,
    /// Query embedding driving exact Q15 cosine retrieval.
    pub embedding: Vec<f32>,
    /// Maximum results wanted.
    pub limit: usize,
    /// Explicit PAD override; absent uses decayed engine state read-only.
    pub current_state: Option<Pad>,
    /// Explicit Unix-millisecond clock.
    pub now_ms: i64,
    /// Authorization boundary; local scope is used when absent.
    pub scope: Option<RecallScope>,
    /// Query embedding-space identity.
    pub embedding_space: Option<crate::EmbeddingSpaceIdentity>,
    /// Disclosure authority.
    pub disclosure_authority: DisclosureAuthority,
    /// Disclosure purpose.
    pub disclosure_purpose: MemoryPurpose,
    /// Phase 7 pipeline controls.
    pub options: RecallOptions,
}

/// One policy-safe evidence citation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Citation {
    /// Memory carrying the evidence.
    pub memory_id: String,
    /// Upstream source ID when known.
    pub source_id: Option<String>,
    /// Upstream source URI when known.
    pub source_uri: Option<String>,
    /// Canonical ingestion event ID when known.
    pub event_id: Option<String>,
    /// Immutable content digest.
    pub content_hash: String,
    /// Current claim IDs supported by this result.
    pub claim_ids: Vec<String>,
    /// Graph path explaining graph-assisted retrieval.
    pub graph_path: Vec<String>,
}

/// Transparent reason one branch contributed a result.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallReason {
    /// Contributing branch.
    pub branch: SearchBranch,
    /// Normalized branch score.
    pub score: f64,
    /// Stable human-readable explanation.
    pub detail: String,
}

/// One recalled memory with score, branch, citation and disclosure evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct ScoredMemory {
    /// Policy-safe memory metadata.
    pub memory: RecalledMemory,
    /// Six cognitive channels.
    pub channels: celiums_cognition::ChannelScores,
    /// Final score after optional reranking.
    pub final_score: f64,
    /// Policy-safe content view.
    pub disclosed_content: Option<String>,
    /// Applied disclosure class.
    pub disclosure: DisclosureClass,
    /// Candidate branches that contributed this memory.
    pub branches: Vec<SearchBranch>,
    /// Per-branch explanations.
    pub why_recalled: Vec<RecallReason>,
    /// Evidence and provenance citations.
    pub citations: Vec<Citation>,
}

/// Why the complete recall response returned no context.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecallAbstention {
    /// No memory survived authorization and requested filters.
    NoVisibleCandidates,
    /// Candidates existed but none crossed the cognitive score floor.
    BelowThreshold,
    /// Candidates existed but disclosure policy withheld every result.
    PolicyRestricted,
    /// Context budget could not fit any content.
    BudgetExhausted,
}

/// Why one retrieval branch produced no candidates.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BranchAbstention {
    /// No candidates existed in the authorized corpus.
    NoCandidates,
    /// Best semantic score was below the candidate threshold.
    BelowThreshold,
    /// Semantic best/runner-up margin was ambiguous.
    Ambiguous,
    /// The branch was disabled by request policy.
    Disabled,
}

/// Complete read-only recall response.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallResponse {
    /// Ranked, diverse memories.
    pub results: Vec<ScoredMemory>,
    /// Lexical branch abstention.
    pub lexical_abstention: Option<BranchAbstention>,
    /// Semantic branch abstention.
    pub semantic_abstention: Option<BranchAbstention>,
    /// Graph branch abstention.
    pub graph_abstention: Option<BranchAbstention>,
    /// Temporal branch abstention.
    pub temporal_abstention: Option<BranchAbstention>,
    /// Overall abstention after policy and scoring.
    pub overall_abstention: Option<RecallAbstention>,
    /// Number of unique candidates before final selection.
    pub candidate_count: usize,
    /// Reranking path used.
    pub reranker_status: RerankerStatus,
    /// Whether graph traversal hit a bound.
    pub graph_truncated: bool,
    /// Graph edges inspected.
    pub graph_inspected_edges: usize,
    /// First graph budget that truncated traversal.
    pub graph_truncation_reason: Option<crate::GraphTruncationReason>,
    /// Whether the global candidate union hit its bound.
    pub union_truncated: bool,
}

/// Request for ID/score-only search.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactSearchRequest {
    /// Underlying read-only recall request.
    pub recall: RecallRequest,
    /// Maximum compact rows.
    pub limit: usize,
}

/// One compact search row without content hydration.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactSearchResult {
    /// Memory ID.
    pub id: String,
    /// Final score.
    pub score: f64,
    /// Contributing branches.
    pub branches: Vec<SearchBranch>,
    /// Recall explanations.
    pub why_recalled: Vec<RecallReason>,
    /// Evidence citations.
    pub citations: Vec<Citation>,
    /// Reserved for explicit hydration; always absent in compact search.
    pub content: Option<String>,
}

/// Complete compact search response.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactSearchResponse {
    /// Compact rows.
    pub results: Vec<CompactSearchResult>,
    /// Overall abstention.
    pub abstention: Option<RecallAbstention>,
    /// Reranking path used.
    pub reranker_status: RerankerStatus,
}

/// Scoped policy-safe hydration request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HydrateRequest {
    /// Memory IDs in desired output order.
    pub ids: Vec<String>,
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Disclosure authority.
    pub disclosure_authority: DisclosureAuthority,
    /// Disclosure purpose.
    pub disclosure_purpose: MemoryPurpose,
}

/// One policy-safe memory resource request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisclosedMemoryRequest {
    /// Memory ID.
    pub id: String,
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Disclosure authority.
    pub disclosure_authority: DisclosureAuthority,
    /// Disclosure purpose.
    pub disclosure_purpose: MemoryPurpose,
}

/// One hydrated policy-safe memory view.
#[derive(Clone, Debug, PartialEq)]
pub struct HydratedMemory {
    /// Memory ID.
    pub id: String,
    /// Optimistic-concurrency revision.
    pub revision: u64,
    /// Governed content, never raw policy-bypassing content.
    pub content: String,
    /// Applied disclosure class.
    pub disclosure: DisclosureClass,
    /// Safe tags; currently empty until tag governance is defined.
    pub tags: Vec<String>,
    /// Importance metadata.
    pub importance: f64,
    /// Memory classification.
    pub memory_type: celiums_cognition::MemoryType,
    /// Creation clock.
    pub created_at_ms: i64,
    /// Source citation.
    pub citation: Citation,
}

/// One policy-safe paginated memory resource page.
#[derive(Clone, Debug, PartialEq)]
pub struct HydratedMemoryPage {
    /// Policy-safe memory views.
    pub memories: Vec<HydratedMemory>,
    /// Opaque numeric continuation offset when more rows exist.
    pub next_offset: Option<usize>,
}

/// Request to produce bounded context sections.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextComposeRequest {
    /// Underlying recall request.
    pub recall: RecallRequest,
    /// Deterministic estimator-v1 token budget.
    pub token_budget: usize,
}

/// Context section classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContextSectionKind {
    /// Current temporal truth.
    CurrentTruth,
    /// Graph-related evidence.
    RelatedEvidence,
    /// Direct semantic or lexical evidence.
    Evidence,
}

/// One token-bounded context section.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextSection {
    /// Section kind.
    pub kind: ContextSectionKind,
    /// Policy-safe bounded text.
    pub content: String,
    /// Estimated tokens under estimator v1.
    pub estimated_tokens: usize,
    /// Evidence citations.
    pub citations: Vec<Citation>,
    /// Recall explanations.
    pub why_recalled: Vec<RecallReason>,
}

/// Complete deterministic context composition.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextComposition {
    /// Ordered sections.
    pub sections: Vec<ContextSection>,
    /// Sum of estimator-v1 section costs.
    pub estimated_tokens: usize,
    /// Whether at least one result was omitted or truncated.
    pub truncated: bool,
    /// Plain-text rendering of the sections.
    pub rendered: String,
    /// Recall abstention when no section could be composed.
    pub abstention: Option<RecallAbstention>,
    /// Relevant cited evidence per 1,000 estimated tokens.
    pub evidence_density_milli: u64,
}

/// Legacy graph wrapper retained while callers migrate to unified recall.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphRecallRequest {
    /// Standard recall request.
    pub recall: RecallRequest,
    /// Graph depth budget.
    pub max_depth: usize,
    /// Graph edge budget.
    pub max_edges: usize,
    /// Graph entity budget.
    pub max_entities: usize,
    /// Graph memory budget.
    pub max_memories: usize,
}

/// Legacy graph result mapped from unified recall.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphScoredMemory {
    /// Recalled memory.
    pub memory: RecalledMemory,
    /// Cognitive channels.
    pub channels: celiums_cognition::ChannelScores,
    /// Final score.
    pub final_score: f64,
    /// Graph contribution.
    pub graph_score: f64,
    /// Policy-safe content.
    pub disclosed_content: Option<String>,
    /// Disclosure decision.
    pub disclosure: DisclosureClass,
    /// Graph path.
    pub graph_path: Vec<EntityId>,
}

/// Legacy graph response mapped from unified recall.
#[derive(Clone, Debug, PartialEq)]
pub struct GraphRecallResponse {
    /// Ranked results.
    pub results: Vec<GraphScoredMemory>,
    /// Whether graph traversal truncated.
    pub graph_truncated: bool,
    /// Graph truncation reason.
    pub graph_truncation_reason: Option<crate::GraphTruncationReason>,
    /// Visible edges inspected.
    pub graph_inspected_edges: usize,
}

/// Explicit mutating feedback that reactivates already disclosed results.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecallFeedbackRequest {
    /// Memory IDs selected by the caller.
    pub ids: Vec<String>,
    /// Authorization boundary.
    pub scope: RecallScope,
    /// Explicit feedback clock.
    pub now_ms: i64,
}

/// Outcome of explicit recall feedback.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RecallFeedbackReport {
    /// Memories reactivated.
    pub reactivated: u64,
}
