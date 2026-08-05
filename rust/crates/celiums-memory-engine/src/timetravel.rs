// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Time-travel recall: query what the engine knew at a past moment.
//!
//! Hyphae snapshots accumulate per checkpoint (`snapshot-{seq}.hysnap`,
//! never rotated by compaction) and are cryptographically verified on
//! load (CRC32C + BLAKE3 + canonical order). This module loads one
//! verified snapshot and runs the same hybrid retrieval + cognitive
//! re-ranking pipeline over its contents — the live store is never
//! touched, and results carry the snapshot's own evidence.
//!
//! No competitor can answer "what did the agent believe last Tuesday,
//! and prove it" — this is where the durable substrate pays off.

use std::path::{Path, PathBuf};
use std::time::Duration;

use celiums_cognition::{
    ChannelScores, MemoryState, emotional_weight, recall, resonance, retrievability,
};
use hyphae_query::Record;
use hyphae_retrieval::{
    DurableVectorRecord, ExactRetrievalLimits, ExactRetrievalOutcome, ExactRetrievalRequest,
    LexicalLimits, LexicalOutcome, LexicalRequest, retrieve_exact, retrieve_lexical,
};
use hyphae_storage::{SnapshotContents, SnapshotReadLimits, load_snapshot_with_timeout};

use crate::engine::{RecallConfig, RecallRequest, RecallResponse, ScoredMemory, memory_visible_to};
use crate::memory::Memory;
use crate::quantize::quantize;
use crate::{BranchAbstention, MemoryEngineError, RecallScope};

/// Snapshot load timeout.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// One available point in time.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotPoint {
    /// Snapshot file path.
    pub path: PathBuf,
    /// Checkpoint sequence (monotonic; higher = later).
    pub checkpoint_sequence: u64,
}

/// Lists the available snapshot points in a data directory, oldest
/// first. Sequences are parsed from the canonical
/// `snapshot-{seq:020}.hysnap` names.
///
/// # Errors
///
/// Fails when the snapshots directory cannot be read.
pub fn snapshot_points(data_dir: impl AsRef<Path>) -> Result<Vec<SnapshotPoint>, std::io::Error> {
    let snapshots_dir = data_dir.as_ref().join("snapshots");
    if !snapshots_dir.exists() {
        return Ok(Vec::new());
    }
    let mut points = Vec::new();
    for entry in std::fs::read_dir(snapshots_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(sequence) = name
            .strip_prefix("snapshot-")
            .and_then(|rest| rest.strip_suffix(".hysnap"))
            .and_then(|digits| digits.parse::<u64>().ok())
        else {
            continue;
        };
        points.push(SnapshotPoint {
            path: entry.path(),
            checkpoint_sequence: sequence,
        });
    }
    points.sort_by_key(|point| point.checkpoint_sequence);
    Ok(points)
}

/// Recalls memories as they existed in one snapshot.
///
/// The full pipeline of [`crate::MemoryEngine::recall`] — hybrid
/// candidates, six-channel cognitive re-ranking, archived exclusion —
/// but over the snapshot's contents, read-only: no reactivation, no
/// affect update. Requests without an explicit `current_state` score
/// resonance neutrally (the snapshot's affect state is history, not a
/// live limbic system).
///
/// # Errors
///
/// Fails when the snapshot cannot be verified or decoded, or when the
/// query embedding is invalid for the snapshot's memory space.
pub fn recall_at(
    snapshot_path: impl AsRef<Path>,
    config: &RecallConfig,
    request: &RecallRequest,
) -> Result<RecallResponse, MemoryEngineError> {
    let contents = load_snapshot_with_timeout(
        snapshot_path.as_ref(),
        &SnapshotReadLimits::default(),
        SNAPSHOT_TIMEOUT,
    )
    .map_err(|error| MemoryEngineError::Snapshot {
        detail: error.to_string(),
    })?;

    let memory_space = crate::engine::memory_space();
    let dimension = contents
        .vector_spaces
        .iter()
        .find(|space| space.name == memory_space)
        .map(|space| space.dimension)
        .ok_or_else(|| MemoryEngineError::Snapshot {
            detail: "snapshot has no memory vector space".to_owned(),
        })?;

    let query_vector = quantize(&request.embedding, dimension)?;
    let candidate_limit = request.limit.max(1).saturating_mul(2);

    let (semantic_scores, semantic_abstention) =
        semantic_candidates(&contents, &memory_space, query_vector, candidate_limit)?;
    let (lexical_scores, lexical_abstention) =
        lexical_candidates(&contents, &request.query_text, candidate_limit)?;

    let mut candidates: std::collections::BTreeMap<Vec<u8>, (f64, f64)> = Default::default();
    for (key, semantic) in semantic_scores {
        candidates.entry(key).or_insert((0.0, 0.0)).0 = semantic;
    }
    for (key, lexical) in lexical_scores {
        candidates.entry(key).or_insert((0.0, 0.0)).1 = lexical;
    }

    let current_state = request.current_state.unwrap_or_default();
    let scope = request.scope.clone().unwrap_or_else(RecallScope::local);
    let current_arousal = request
        .current_state
        .map_or_else(recall::neutral_arousal, |state| state.arousal);

    let mut scored = Vec::with_capacity(candidates.len());
    for (key, (semantic, text_match)) in candidates {
        let memory = snapshot_memory(&contents, &key)?;
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
            resonance: if request.current_state.is_some() {
                resonance(current_state, memory.pad)
            } else {
                0.5
            },
        };
        let final_score = recall::score(&config.weights, &channels, current_arousal);
        scored.push(ScoredMemory {
            memory,
            channels,
            final_score,
        });
    }

    scored.retain(|entry| entry.final_score >= config.score_threshold);
    scored.sort_by(|left, right| {
        right
            .final_score
            .partial_cmp(&left.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.memory.id.cmp(&right.memory.id))
    });
    scored.truncate(config.max_results.min(request.limit.max(1)));

    Ok(RecallResponse {
        results: scored,
        lexical_abstention,
        semantic_abstention,
    })
}

type BranchScores = (Vec<(Vec<u8>, f64)>, Option<BranchAbstention>);

fn semantic_candidates(
    contents: &SnapshotContents,
    space: &hyphae_core::VectorSpaceName,
    query: hyphae_core::Q15Vector,
    limit: usize,
) -> Result<BranchScores, MemoryEngineError> {
    let candidates: Vec<DurableVectorRecord> = contents
        .vectors
        .iter()
        .filter(|vector| &vector.space == space)
        .map(|vector| DurableVectorRecord {
            key: vector.key.clone(),
            vector: vector.vector.clone(),
        })
        .collect();
    let outcome = retrieve_exact(
        &candidates,
        &ExactRetrievalRequest {
            vector_space: space.clone(),
            query,
            limit,
            minimum_score_nanos: 200_000_000,
            minimum_margin_nanos: 0,
        },
        &ExactRetrievalLimits::default(),
    )
    .map_err(hyphae_engine::EngineError::from)?;
    Ok(match outcome {
        ExactRetrievalOutcome::Matches { matches, .. } => (
            matches
                .into_iter()
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
                hyphae_retrieval::ExactAbstentionReason::NoCandidates => {
                    BranchAbstention::NoCandidates
                }
                hyphae_retrieval::ExactAbstentionReason::BelowThreshold => {
                    BranchAbstention::BelowThreshold
                }
                hyphae_retrieval::ExactAbstentionReason::Ambiguous => BranchAbstention::Ambiguous,
            }),
        ),
    })
}

fn lexical_candidates(
    contents: &SnapshotContents,
    query_text: &str,
    limit: usize,
) -> Result<BranchScores, MemoryEngineError> {
    let index_name = crate::engine::content_index();
    let Some(definition) = contents
        .lexical_indexes
        .iter()
        .find(|index| index.name == index_name)
    else {
        return Ok((Vec::new(), Some(BranchAbstention::NoCandidates)));
    };

    let mut records = Vec::new();
    for entry in &contents.entries {
        // Only memory records participate; other kinds (journal,
        // entities, affect state) have no `content` field and score
        // nothing, but skipping non-documents loudly matters here:
        // a snapshot entry that fails to decode is corruption.
        let value = hyphae_engine::decode_document(&entry.value)
            .map_err(hyphae_engine::EngineError::from)?;
        records.push(Record::new(entry.key.clone(), value));
    }

    let outcome = retrieve_lexical(
        &records,
        definition,
        &LexicalRequest {
            index: index_name,
            query: query_text.to_owned(),
            limit,
        },
        &LexicalLimits::default(),
    )
    .map_err(hyphae_engine::EngineError::from)?;
    Ok(match outcome {
        LexicalOutcome::Matches { matches, .. } => {
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
        LexicalOutcome::Abstained(_) => (Vec::new(), Some(BranchAbstention::NoCandidates)),
    })
}

fn snapshot_memory(contents: &SnapshotContents, key: &[u8]) -> Result<Memory, MemoryEngineError> {
    let entry = contents
        .entries
        .iter()
        .find(|entry| entry.key == key)
        .ok_or_else(|| MemoryEngineError::MissingCandidate {
            id: String::from_utf8_lossy(key).into_owned(),
        })?;
    let value =
        hyphae_engine::decode_document(&entry.value).map_err(hyphae_engine::EngineError::from)?;
    Ok(Memory::from_record(&Record::new(entry.key.clone(), value))?)
}

fn days_between(earlier_ms: i64, later_ms: i64) -> f64 {
    const MS_PER_DAY: f64 = 1000.0 * 60.0 * 60.0 * 24.0;
    #[allow(clippy::cast_precision_loss)]
    let elapsed = (later_ms.saturating_sub(earlier_ms)) as f64;
    f64::max(0.0, elapsed / MS_PER_DAY)
}
