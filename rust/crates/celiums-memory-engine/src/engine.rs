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
    ChannelScores, JournalEntryType, LimbicConfig, MemoryInfluence, MemoryState, Pad,
    RecallWeights, Scope, SupersessionRelation, classify_importance, classify_memory_type,
    emotional_weight, extract_entities, extract_pad, is_valid_agent_id, limbic, recall, resonance,
    retention, retrievability,
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
use crate::entity_index::{EntityRecord, entity_key, entity_prefix};
use crate::journal::{
    BrokenLink, BrokenReason, ChainReport, JournalEntry, MAX_VALENCE_REASON_CHARS, Supersession,
    agent_prefix, chain_hash, entry_key, supersession_prefix,
};
use crate::memory::{Memory, MemoryDecodeError};
use crate::quantize::{QuantizeError, quantize};

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
    dimension: u16,
    config: RecallConfig,
    limbic_config: LimbicConfig,
    affect: AffectState,
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
        let opened = HyphaeEngine::open(path)?;
        let mut hyphae = opened.engine;
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
        Ok(Self {
            hyphae,
            dimension,
            config,
            limbic_config,
            affect,
        })
    }

    /// Current limbic (PAD) state after homeostatic decay to `now_ms`.
    ///
    /// Fresh-on-read: the stored snapshot is decayed by the elapsed
    /// time on every read, so long-idle engines report a state near
    /// baseline instead of a stale spike.
    pub fn affect_state(&self, now_ms: i64) -> Pad {
        limbic::decay(
            self.affect.pad,
            &self.limbic_config,
            minutes_between(self.affect.updated_at_ms, now_ms),
        )
    }

    /// Stores one memory: classifies importance, affect and type from
    /// the content, then persists the document and its embedding.
    ///
    /// # Errors
    ///
    /// Fails on quantisation (including dimension mismatch) or storage
    /// failure. Nothing is stored when the embedding is invalid.
    pub fn remember(&mut self, request: RememberRequest) -> Result<Memory, MemoryEngineError> {
        let vector = quantize(&request.embedding, self.dimension)?;

        let (classified_importance, _signals) = classify_importance(&request.content);
        let memory = Memory {
            id: Uuid::now_v7().to_string(),
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
            last_retrieved_at_ms: request.now_ms,
            content: request.content,
        };

        self.hyphae
            .put_record(Uuid::now_v7(), &memory.to_record())?;
        self.hyphae
            .put_vectors(Uuid::now_v7(), &memory_space(), &[(memory.key(), vector)])?;
        self.index_entities(&memory)?;

        // The stimulus moves the engine's own emotional state — the
        // amygdala pass of the TS pipeline (limbic.updateState on input).
        self.update_affect(memory.pad, &[], request.now_ms)?;
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
            let memory = self.load_memory(&key)?;
            if memory.state == MemoryState::Archived {
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
            scored.push(ScoredMemory {
                memory,
                channels,
                final_score,
            });
        }

        scored.retain(|entry| entry.final_score >= self.config.score_threshold);
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
    fn update_affect(
        &mut self,
        input: Pad,
        recalled: &[MemoryInfluence],
        now_ms: i64,
    ) -> Result<(), MemoryEngineError> {
        let decayed = self.affect_state(now_ms);
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
