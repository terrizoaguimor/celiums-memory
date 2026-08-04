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
    ChannelScores, LimbicConfig, MemoryInfluence, Pad, RecallWeights, Scope, classify_importance,
    classify_memory_type, emotional_weight, extract_pad, limbic, recall, resonance, retention,
    retrievability,
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
            scope: request.scope,
            tags: request.tags,
            created_at_ms: request.now_ms,
            last_retrieved_at_ms: request.now_ms,
            content: request.content,
        };

        self.hyphae
            .put_record(Uuid::now_v7(), &memory.to_record())?;
        self.hyphae
            .put_vectors(Uuid::now_v7(), &memory_space(), &[(memory.key(), vector)])?;

        // The stimulus moves the engine's own emotional state — the
        // amygdala pass of the TS pipeline (limbic.updateState on input).
        self.update_affect(memory.pad, &[], request.now_ms)?;
        Ok(memory)
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
            entry.memory.last_retrieved_at_ms = now_ms;
            self.hyphae
                .put_record(Uuid::now_v7(), &entry.memory.to_record())?;
        }
        Ok(())
    }
}

fn memory_space() -> VectorSpaceName {
    VectorSpaceName::new(MEMORY_SPACE).unwrap_or_else(|_| unreachable!("static valid name"))
}

fn content_index() -> VectorSpaceName {
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
