// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 7 recall contract: prefiltered candidates, bounded branch union, diversity and context.

mod support;

use celiums_cognition::{ContentRole, DisclosureAuthority, MemoryPurpose, Scope};
use celiums_memory_engine::{
    ClaimEvidenceInput, ClaimEvidenceRelation, CompactSearchRequest, ContextComposeRequest,
    CreateClaimRequest, CreateEntityRequest, FilterOperator, FilterValue, GraphEvidenceInput,
    HydrateRequest, MemoryField, MemoryFilter, MemoryPredicate, RecallOptions, RecallRequest,
    RememberRequest, RerankerStatus, SearchBranch,
};

use support::{NOW_MS, open, scope};

fn remember(
    engine: &mut celiums_memory_engine::MemoryEngine,
    content: &str,
    tag: &str,
) -> celiums_memory_engine::Memory {
    engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding: celiums_memory_engine::deterministic_embed(content, 4),
            tags: vec![tag.to_owned()],
            scope: Scope::Global,
            importance: Some(0.9),
            now_ms: NOW_MS,
            context: Some(celiums_memory_engine::RememberContext {
                identity: celiums_memory_engine::MemoryIdentity {
                    tenant_id: scope().tenant_id,
                    user_id: scope().user_id,
                    agent_id: None,
                    project_id: None,
                    conversation_id: None,
                    session_id: None,
                },
                provenance: celiums_memory_engine::Provenance::observed(
                    celiums_memory_engine::SourceKind::User,
                    content,
                    None,
                    None,
                    None,
                ),
                event_at_ms: Some(NOW_MS),
                ingested_at_ms: NOW_MS,
            }),
            embedding_space: None,
            idempotency_key: None,
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("remember")
}

fn request(query: &str) -> RecallRequest {
    RecallRequest {
        query_text: query.to_owned(),
        embedding: celiums_memory_engine::deterministic_embed(query, 4),
        limit: 10,
        current_state: None,
        now_ms: NOW_MS,
        scope: Some(scope()),
        embedding_space: None,
        disclosure_authority: DisclosureAuthority::Owner,
        disclosure_purpose: MemoryPurpose::ConversationalContext,
        options: RecallOptions::default(),
    }
}

#[test]
fn filters_are_applied_before_semantic_and_lexical_ranking() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for index in 0..30 {
        remember(
            &mut engine,
            &format!("Rust deployment distractor {index}"),
            "noise",
        );
    }
    let wanted = remember(&mut engine, "Rust deployment canonical answer", "wanted");
    let mut recall = request("Rust deployment");
    recall.limit = 1;
    recall.options.filter = Some(MemoryFilter::Predicate(MemoryPredicate {
        field: MemoryField::Tags,
        operator: FilterOperator::Contains,
        value: Some(FilterValue::String("wanted".to_owned())),
    }));

    let response = engine.recall(recall).expect("recall");

    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].memory.id, wanted.id);
    assert_eq!(response.candidate_count, 1);
}

#[test]
fn recall_is_read_only_and_frozen_input_is_deterministic() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let memory = remember(&mut engine, "Hyphae keeps retrieval deterministic", "work");
    let before = engine
        .get_memory(&memory.id, &scope())
        .expect("before")
        .expect("memory");

    let first = engine
        .recall(request("Hyphae deterministic"))
        .expect("first");
    let second = engine
        .recall(request("Hyphae deterministic"))
        .expect("second");
    let after = engine
        .get_memory(&memory.id, &scope())
        .expect("after")
        .expect("memory");

    assert_eq!(first, second);
    assert_eq!(before, after);
}

#[test]
fn branch_union_preserves_provenance_and_deterministic_fallback() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    remember(
        &mut engine,
        "Cloudflare Durable Objects isolate tenants",
        "infra",
    );

    let response = engine
        .recall(request("Cloudflare Durable Objects"))
        .expect("recall");

    assert_eq!(
        response.reranker_status,
        RerankerStatus::DeterministicFallback
    );
    assert!(
        response.results[0]
            .branches
            .contains(&SearchBranch::Semantic)
    );
    assert!(
        response.results[0]
            .branches
            .contains(&SearchBranch::Lexical)
    );
    assert!(!response.results[0].why_recalled.is_empty());
    assert!(!response.results[0].citations.is_empty());
}

#[test]
fn compact_search_hydrate_and_context_respect_budgets() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first = remember(&mut engine, "Use Rust with Hyphae for memory", "work");
    remember(&mut engine, "Use Rust with Hyphae for memory", "duplicate");
    remember(&mut engine, "Cloudflare is the production runtime", "infra");

    let search = engine
        .search_compact(CompactSearchRequest {
            recall: request("Rust Hyphae memory"),
            limit: 3,
        })
        .expect("search");
    assert!(search.results.len() <= 2, "duplicate content must collapse");
    assert!(search.results.iter().all(|result| result.content.is_none()));

    let hydrated = engine
        .hydrate(HydrateRequest {
            ids: vec![first.id],
            scope: scope(),
            disclosure_authority: DisclosureAuthority::Owner,
            disclosure_purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("hydrate");
    assert_eq!(hydrated.len(), 1);
    assert!(hydrated[0].content.contains("Hyphae"));

    let context = engine
        .compose_context(ContextComposeRequest {
            recall: request("Rust Hyphae memory"),
            token_budget: 24,
        })
        .expect("context");
    assert!(context.estimated_tokens <= 24);
    assert!(!context.sections.is_empty());
    assert!(
        context
            .sections
            .iter()
            .all(|section| !section.citations.is_empty())
    );
}

#[test]
fn graph_and_temporal_candidates_join_the_same_bounded_union() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let source = support::episode(&mut engine, "source-event", "Alpha deployment region nyc1");
    let target = engine
        .remember(RememberRequest {
            content: "Alpha deployment region nyc1".to_owned(),
            embedding: celiums_memory_engine::deterministic_embed("unrelated vector", 4),
            tags: vec!["current".to_owned()],
            scope: Scope::Global,
            importance: Some(0.9),
            now_ms: NOW_MS,
            context: Some(celiums_memory_engine::RememberContext {
                identity: celiums_memory_engine::MemoryIdentity {
                    tenant_id: scope().tenant_id,
                    user_id: scope().user_id,
                    agent_id: None,
                    project_id: None,
                    conversation_id: None,
                    session_id: None,
                },
                provenance: {
                    let mut provenance = celiums_memory_engine::Provenance::observed(
                        celiums_memory_engine::SourceKind::User,
                        "Alpha deployment region nyc1",
                        Some("source-event".to_owned()),
                        None,
                        None,
                    );
                    provenance.event_id = Some(source.event_id.to_string());
                    provenance.source_namespace = Some(source.source_namespace.to_string());
                    provenance.turn_id = source.turn_id.as_ref().map(ToString::to_string);
                    provenance
                },
                event_at_ms: Some(NOW_MS),
                ingested_at_ms: NOW_MS,
            }),
            embedding_space: None,
            idempotency_key: None,
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("target");
    let entity = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: "Alpha".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: source.event_id.clone(),
                excerpt: Some("Alpha".to_owned()),
            }],
        })
        .expect("entity");
    engine
        .bind_memory_entity(&target.id, &entity.id, &scope())
        .expect("bind");
    engine
        .create_claim(CreateClaimRequest {
            scope: scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            value: "nyc1".to_owned(),
            confidence: 1.0,
            valid_from_ms: Some(NOW_MS),
            valid_to_ms: None,
            recorded_at_ms: NOW_MS,
            evidence: vec![ClaimEvidenceInput {
                event_id: source.event_id,
                relation: ClaimEvidenceRelation::Supports,
                excerpt: Some("region nyc1".to_owned()),
            }],
        })
        .expect("claim");

    let response = engine
        .recall(request("Alpha deployment region"))
        .expect("recall");
    let result = response
        .results
        .iter()
        .find(|result| result.memory.id == target.id)
        .expect("target in union");
    assert!(result.branches.contains(&SearchBranch::Graph));
    assert!(result.branches.contains(&SearchBranch::Temporal));
    assert!(response.candidate_count <= 40);
}

#[test]
fn strict_union_and_zero_branch_budgets_are_enforced() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for index in 0..20 {
        remember(
            &mut engine,
            &format!("bounded candidate {index}"),
            "bounded",
        );
    }
    let mut recall = request("bounded candidate");
    recall.options.branches.max_union_candidates = 3;
    recall.options.branches.graph_max_memories = 0;
    recall.options.branches.temporal_max_memories = 0;
    recall.options.branches.graph = false;
    recall.options.branches.temporal = false;

    let response = engine.recall(recall).expect("recall");

    assert_eq!(response.candidate_count, 3);
    assert!(response.union_truncated);
    assert_eq!(
        response.graph_abstention,
        Some(celiums_memory_engine::BranchAbstention::Disabled)
    );
    assert_eq!(
        response.temporal_abstention,
        Some(celiums_memory_engine::BranchAbstention::Disabled)
    );
}

#[test]
fn incomplete_external_reranker_falls_back_for_the_whole_response() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    remember(&mut engine, "Rust recall candidate one", "one");
    remember(&mut engine, "Rust recall candidate two", "two");
    let mut recall = request("Rust recall candidate");
    recall.options.reranker = celiums_memory_engine::RerankerInput::External(
        celiums_memory_engine::ExternalRerankerScores {
            identity: celiums_memory_engine::RerankerIdentity {
                provider: "local".to_owned(),
                model: "cross-encoder".to_owned(),
                revision: "v1".to_owned(),
            },
            scores_nanos: std::collections::BTreeMap::new(),
        },
    );

    let response = engine.recall(recall).expect("recall");
    assert!(matches!(
        response.reranker_status,
        RerankerStatus::ExternalUnavailableFallback(_)
    ));
}

#[test]
fn zero_context_budget_reports_explicit_abstention() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    remember(
        &mut engine,
        "Cloudflare context cannot fit zero tokens",
        "budget",
    );

    let context = engine
        .compose_context(ContextComposeRequest {
            recall: request("Cloudflare context"),
            token_budget: 0,
        })
        .expect("context");

    assert!(context.sections.is_empty());
    assert_eq!(
        context.abstention,
        Some(celiums_memory_engine::RecallAbstention::BudgetExhausted)
    );
}

#[test]
fn explicit_feedback_reactivates_without_making_recall_impure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let stored = remember(&mut engine, "Explicit recall feedback", "feedback");
    engine.recall(request("Explicit feedback")).expect("recall");
    let unchanged = engine
        .get_memory(&stored.id, &scope())
        .expect("memory")
        .expect("stored");
    assert_eq!(unchanged.retrieval_count, 0);

    engine
        .record_recall_feedback(celiums_memory_engine::RecallFeedbackRequest {
            ids: vec![stored.id.clone()],
            scope: scope(),
            now_ms: NOW_MS + 1,
        })
        .expect("feedback");
    let reinforced = engine
        .get_memory(&stored.id, &scope())
        .expect("memory")
        .expect("stored");
    assert_eq!(reinforced.retrieval_count, 1);
}

#[test]
fn current_recall_omits_evidence_of_a_superseded_claim() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let old_source = support::episode(&mut engine, "old", "deployment region nyc1");
    let new_source = support::episode(&mut engine, "new", "deployment region sfo3");
    let old_memory = engine
        .remember(RememberRequest {
            content: old_source.content.clone(),
            embedding: celiums_memory_engine::deterministic_embed(&old_source.content, 4),
            tags: Vec::new(),
            scope: Scope::Global,
            importance: Some(1.0),
            now_ms: NOW_MS,
            context: Some(context_for_event(&old_source)),
            embedding_space: None,
            idempotency_key: None,
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("old memory");
    let new_memory = engine
        .remember(RememberRequest {
            content: new_source.content.clone(),
            embedding: celiums_memory_engine::deterministic_embed(&new_source.content, 4),
            tags: Vec::new(),
            scope: Scope::Global,
            importance: Some(1.0),
            now_ms: NOW_MS + 1,
            context: Some(context_for_event(&new_source)),
            embedding_space: None,
            idempotency_key: None,
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("new memory");
    let old_claim = engine
        .create_claim(support::claim_request(
            &old_source,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            None,
        ))
        .expect("old claim");
    let new_claim = engine
        .create_claim(support::claim_request(
            &new_source,
            "deployment",
            "region",
            "sfo3",
            NOW_MS + 1,
            None,
        ))
        .expect("new claim");
    engine
        .supersede_claim(celiums_memory_engine::SupersedeClaimRequest {
            scope: scope(),
            original_claim_id: old_claim.id,
            successor_claim_id: Some(new_claim.id),
            relation: celiums_memory_engine::ClaimSupersessionRelation::Supersedes,
            effective_at_ms: NOW_MS + 1,
            recorded_at_ms: NOW_MS + 1,
            reason: None,
        })
        .expect("supersede");

    let mut recall = request("deployment region");
    recall.now_ms = NOW_MS + 2;
    let response = engine.recall(recall).expect("recall");
    assert!(
        !response
            .results
            .iter()
            .any(|result| result.memory.id == old_memory.id)
    );
    assert!(
        response
            .results
            .iter()
            .any(|result| result.memory.id == new_memory.id)
    );
}

#[test]
fn zero_union_budget_fails_instead_of_expanding_silently() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    remember(&mut engine, "candidate budget zero", "budget");
    let mut recall = request("candidate budget");
    recall.options.branches.max_union_candidates = 0;
    assert!(engine.recall(recall).is_err());
}

fn context_for_event(
    event: &celiums_memory_engine::IngestionEntry,
) -> celiums_memory_engine::RememberContext {
    let mut provenance = celiums_memory_engine::Provenance::observed(
        celiums_memory_engine::SourceKind::User,
        &event.content,
        Some(event.source_event_id.to_string()),
        None,
        None,
    );
    provenance.event_id = Some(event.event_id.to_string());
    celiums_memory_engine::RememberContext {
        identity: celiums_memory_engine::MemoryIdentity {
            tenant_id: scope().tenant_id,
            user_id: scope().user_id,
            agent_id: None,
            project_id: None,
            conversation_id: None,
            session_id: None,
        },
        provenance,
        event_at_ms: event.event_at_ms,
        ingested_at_ms: event.first_ingested_at_ms,
    }
}
