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
    LexicalIndexDefinition, LexicalLimits, LexicalOutcome, LexicalRequest, retrieve_exact,
    retrieve_lexical,
};
use hyphae_storage::{SnapshotContents, SnapshotReadLimits, load_snapshot_with_timeout};

use crate::engine::{RecallConfig, memory_visible_to};
use crate::memory::Memory;
use crate::quantize::quantize;
use crate::{
    BranchAbstention, MemoryEngineError, RecallRequest, RecallResponse, RecallScope, ScoredMemory,
};

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
    if request.limit == 0 || request.options.branches.max_union_candidates == 0 {
        return Err(MemoryEngineError::InvalidRecallRequest {
            detail: "snapshot result and union budgets must be nonzero",
        });
    }
    if request.options.branches.graph
        || request.options.branches.temporal
        || !matches!(
            request.options.reranker,
            crate::RerankerInput::Deterministic
        )
    {
        return Err(MemoryEngineError::Snapshot {
            detail: "snapshot recall supports semantic/lexical deterministic branches only"
                .to_owned(),
        });
    }
    let contents = load_snapshot_with_timeout(
        snapshot_path.as_ref(),
        &SnapshotReadLimits::default(),
        SNAPSHOT_TIMEOUT,
    )
    .map_err(|error| MemoryEngineError::Snapshot {
        detail: error.to_string(),
    })?;

    let memory_space = crate::engine::memory_space();
    let snapshot_embedding = snapshot_embedding_identity(&contents)?;
    if let Some(requested) = &request.embedding_space
        && requested != &snapshot_embedding
    {
        return Err(MemoryEngineError::EmbeddingSpaceMismatch {
            expected: format!(
                "{}/{}/{}:{}:{}",
                snapshot_embedding.provider,
                snapshot_embedding.model,
                snapshot_embedding.revision,
                snapshot_embedding.dimension,
                snapshot_embedding.normalization.as_str()
            ),
            received: format!(
                "{}/{}/{}:{}:{}",
                requested.provider,
                requested.model,
                requested.revision,
                requested.dimension,
                requested.normalization.as_str()
            ),
        });
    }
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
    let scope = request.scope.clone().unwrap_or_else(RecallScope::local);
    let records = snapshot_visible_memories(&contents, &scope, request.options.filter.as_ref())?;
    let (semantic_scores, semantic_abstention) = if request.options.branches.semantic {
        semantic_candidates(
            &contents,
            &records,
            &memory_space,
            query_vector,
            candidate_limit,
        )?
    } else {
        (Vec::new(), Some(BranchAbstention::Disabled))
    };
    let (lexical_scores, lexical_abstention) = if request.options.branches.lexical {
        lexical_candidates(&records, &request.query_text, candidate_limit)?
    } else {
        (Vec::new(), Some(BranchAbstention::Disabled))
    };

    let mut candidates: std::collections::BTreeMap<Vec<u8>, (f64, f64)> = Default::default();
    for (key, semantic) in semantic_scores {
        candidates.entry(key).or_insert((0.0, 0.0)).0 = semantic;
    }
    for (key, lexical) in lexical_scores {
        candidates.entry(key).or_insert((0.0, 0.0)).1 = lexical;
    }
    let union_budget = request.options.branches.max_union_candidates.min(10_000);
    let union_truncated = if candidates.len() > union_budget {
        let retained = candidates
            .keys()
            .take(union_budget)
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        candidates.retain(|key, _| retained.contains(key));
        true
    } else {
        false
    };

    let current_state = request.current_state.unwrap_or_default();
    let current_arousal = request
        .current_state
        .map_or_else(recall::neutral_arousal, |state| state.arousal);

    let candidate_count = candidates.len();
    let mut scored = Vec::with_capacity(candidate_count);
    for (key, (semantic, text_match)) in candidates {
        let Some(memory) = records.get(&key).cloned() else {
            continue;
        };
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
        let (disclosure, disclosed_content) = crate::engine::disclose_memory(
            &memory,
            request.disclosure_authority,
            request.disclosure_purpose,
        );
        scored.push(ScoredMemory {
            branches: snapshot_branches(semantic, text_match),
            why_recalled: snapshot_reasons(semantic, text_match),
            citations: vec![crate::Citation {
                memory_id: memory.id.clone(),
                source_id: memory.provenance.source_id.clone(),
                source_uri: memory.provenance.source_uri.clone(),
                event_id: memory.provenance.event_id.clone(),
                content_hash: memory.provenance.content_hash.clone(),
                claim_ids: Vec::new(),
                graph_path: Vec::new(),
            }],
            memory: crate::RecalledMemory {
                id: memory.id,
                content: disclosed_content.clone().unwrap_or_default(),
                importance: memory.importance,
                memory_type: memory.memory_type,
                state: memory.state,
                scope: memory.scope,
                event_at_ms: memory.event_at_ms,
                ingested_at_ms: memory.ingested_at_ms,
                retrieval_count: memory.retrieval_count,
                strength: memory.strength,
                last_retrieved_at_ms: memory.last_retrieved_at_ms,
                consolidation_count: memory.consolidation_count,
                tags: Vec::new(),
                vector: memory.vector,
            },
            channels,
            final_score,
            disclosed_content,
            disclosure,
        });
    }

    scored.retain(|entry| {
        entry.final_score >= config.score_threshold
            && entry.disclosure != celiums_cognition::DisclosureClass::Abstain
    });
    scored.sort_by(|left, right| {
        right
            .final_score
            .partial_cmp(&left.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.memory.id.cmp(&right.memory.id))
    });
    scored.truncate(config.max_results.min(request.limit));

    let overall_abstention = scored
        .is_empty()
        .then_some(crate::RecallAbstention::NoVisibleCandidates);
    Ok(RecallResponse {
        results: scored,
        lexical_abstention,
        semantic_abstention,
        graph_abstention: Some(BranchAbstention::Disabled),
        temporal_abstention: Some(BranchAbstention::Disabled),
        overall_abstention,
        candidate_count,
        reranker_status: crate::RerankerStatus::DeterministicFallback,
        graph_truncated: false,
        graph_inspected_edges: 0,
        graph_truncation_reason: None,
        union_truncated,
    })
}

fn snapshot_branches(semantic: f64, lexical: f64) -> Vec<crate::SearchBranch> {
    let mut branches = Vec::new();
    if semantic > 0.0 {
        branches.push(crate::SearchBranch::Semantic);
    }
    if lexical > 0.0 {
        branches.push(crate::SearchBranch::Lexical);
    }
    branches
}

fn snapshot_reasons(semantic: f64, lexical: f64) -> Vec<crate::RecallReason> {
    [
        (
            crate::SearchBranch::Semantic,
            semantic,
            "snapshot exact cosine",
        ),
        (crate::SearchBranch::Lexical, lexical, "snapshot BM25F"),
    ]
    .into_iter()
    .filter(|(_, score, _)| *score > 0.0)
    .map(|(branch, score, detail)| crate::RecallReason {
        branch,
        score,
        detail: detail.to_owned(),
    })
    .collect()
}

type BranchScores = (Vec<(Vec<u8>, f64)>, Option<BranchAbstention>);

fn semantic_candidates(
    contents: &SnapshotContents,
    records: &std::collections::BTreeMap<Vec<u8>, Memory>,
    space: &hyphae_core::VectorSpaceName,
    query: hyphae_core::Q15Vector,
    limit: usize,
) -> Result<BranchScores, MemoryEngineError> {
    let candidates: Vec<DurableVectorRecord> = contents
        .vectors
        .iter()
        .filter(|vector| &vector.space == space && records.contains_key(&vector.key))
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
    records: &std::collections::BTreeMap<Vec<u8>, Memory>,
    query_text: &str,
    limit: usize,
) -> Result<BranchScores, MemoryEngineError> {
    let index_name = crate::engine::content_index();
    let definition = LexicalIndexDefinition::new(
        index_name.clone(),
        vec![hyphae_retrieval::LexicalField {
            path: hyphae_query::FieldPath::field("content"),
            weight_micros: 1_000_000,
        }],
    )
    .map_err(hyphae_engine::EngineError::from)?;
    let records = records.values().map(Memory::to_record).collect::<Vec<_>>();

    let outcome = retrieve_lexical(
        &records,
        &definition,
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

fn snapshot_visible_memories(
    contents: &SnapshotContents,
    scope: &RecallScope,
    filter: Option<&crate::MemoryFilter>,
) -> Result<std::collections::BTreeMap<Vec<u8>, Memory>, MemoryEngineError> {
    use hyphae_query::{ExecutionLimits, Filter, Query};
    let mut records = Vec::new();
    for entry in &contents.entries {
        let value = hyphae_engine::decode_document(&entry.value)
            .map_err(hyphae_engine::EngineError::from)?;
        let record = Record::new(entry.key.clone(), value);
        let hyphae_query::Value::Object(fields) = &record.value else {
            continue;
        };
        if fields.get("kind")
            != Some(&hyphae_query::Value::String(
                crate::memory::MEMORY_KIND.to_owned(),
            ))
        {
            continue;
        }
        let memory = Memory::from_record(&record)?;
        if memory_visible_to(&memory, scope) && memory.state != MemoryState::Archived {
            records.push(record);
        }
    }
    let compiled_filter = match filter {
        Some(filter) => filter.compile()?,
        None => Filter::MatchAll,
    };
    let mut memories = std::collections::BTreeMap::new();
    let mut cursor = None;
    loop {
        let query = Query {
            filter: compiled_filter.clone(),
            sort: Vec::new(),
            cursor,
            limit: 1_000,
            aggregation: None,
        };
        let result =
            hyphae_query::execute(&[records.as_slice()], &query, &ExecutionLimits::default())
                .map_err(hyphae_engine::EngineError::from)?;
        for record in &result.rows {
            memories.insert(record.key.clone(), Memory::from_record(record)?);
        }
        match result.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(memories)
}

fn snapshot_embedding_identity(
    contents: &SnapshotContents,
) -> Result<crate::EmbeddingSpaceIdentity, MemoryEngineError> {
    let entry = contents
        .entries
        .iter()
        .find(|entry| entry.key == crate::embedding_space::EMBEDDING_SPACE_KEY)
        .ok_or_else(|| MemoryEngineError::Snapshot {
            detail: "snapshot has no embedding identity".to_owned(),
        })?;
    let value =
        hyphae_engine::decode_document(&entry.value).map_err(hyphae_engine::EngineError::from)?;
    crate::EmbeddingSpaceIdentity::from_record(&Record::new(entry.key.clone(), value))
        .map_err(Into::into)
}

fn days_between(earlier_ms: i64, later_ms: i64) -> f64 {
    const MS_PER_DAY: f64 = 1000.0 * 60.0 * 60.0 * 24.0;
    #[allow(clippy::cast_precision_loss)]
    let elapsed = (later_ms.saturating_sub(earlier_ms)) as f64;
    f64::max(0.0, elapsed / MS_PER_DAY)
}
