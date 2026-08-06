// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Graph-assisted candidate generation improves multi-hop recall safely.

mod support;

use celiums_cognition::{ContentRole, DisclosureAuthority, MemoryPurpose, Scope};
use celiums_memory_engine::{
    CreateEntityRelationRequest, CreateEntityRequest, DefineRelationTypeRequest,
    GraphEvidenceInput, GraphRecallRequest, MemoryIdentity, Provenance, RecallConfig,
    RecallRequest, RelationDirection, RememberContext, RememberRequest, SourceKind,
    deterministic_embed,
};

use support::{NOW_MS, episode, open, scope};

fn entity(
    engine: &mut celiums_memory_engine::MemoryEngine,
    id: &str,
) -> celiums_memory_engine::CanonicalEntity {
    let evidence = episode(engine, &format!("entity-{id}"), id);
    engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: id.to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id,
                excerpt: Some(id.to_owned()),
            }],
        })
        .expect("entity")
}

fn remember_bound(
    engine: &mut celiums_memory_engine::MemoryEngine,
    content: &str,
    source_id: &str,
) -> celiums_memory_engine::Memory {
    engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding: deterministic_embed(content, 4),
            tags: Vec::new(),
            scope: Scope::Global,
            importance: Some(1.0),
            now_ms: NOW_MS,
            context: Some(RememberContext {
                identity: MemoryIdentity {
                    tenant_id: scope().tenant_id,
                    user_id: scope().user_id,
                    agent_id: None,
                    project_id: None,
                    conversation_id: None,
                    session_id: None,
                },
                provenance: Provenance::observed(
                    SourceKind::User,
                    content,
                    Some(source_id.to_owned()),
                    None,
                    None,
                ),
                event_at_ms: Some(NOW_MS),
                ingested_at_ms: NOW_MS,
            }),
            embedding_space: None,
            idempotency_key: Some(
                celiums_memory_engine::IdempotencyKey::new(source_id).expect("key"),
            ),
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("remember")
}

fn recall_request(query: &str) -> RecallRequest {
    let mut request = RecallRequest {
        query_text: query.to_owned(),
        embedding: deterministic_embed(query, 4),
        limit: 5,
        current_state: None,
        now_ms: NOW_MS,
        scope: Some(scope()),
        embedding_space: None,
        disclosure_authority: DisclosureAuthority::Owner,
        disclosure_purpose: MemoryPurpose::ConversationalContext,
        options: celiums_memory_engine::RecallOptions::default(),
    };
    request.options.branches.graph = false;
    request
}

fn strict_config() -> RecallConfig {
    RecallConfig {
        score_threshold: 0.8,
        enable_reactivation: false,
        ..RecallConfig::default()
    }
}

#[test]
fn graph_recall_finds_multi_hop_memory_missed_by_baseline() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = celiums_memory_engine::MemoryEngine::open_for_tenant(
        dir.path(),
        4,
        strict_config(),
        scope().tenant_id,
    )
    .expect("open");
    let alpha = entity(&mut engine, "Alpha");
    let beta = entity(&mut engine, "Beta");
    let gamma = entity(&mut engine, "Gamma");
    engine
        .define_relation_type(DefineRelationTypeRequest {
            scope: scope(),
            relation_type: "links".to_owned(),
            source_entity_types: vec!["project".to_owned()],
            target_entity_types: vec!["project".to_owned()],
            direction: RelationDirection::Directed,
            traversable: true,
            ontology_version: "v1".to_owned(),
            recorded_at_ms: NOW_MS,
        })
        .expect("type");
    for (id, source, target) in [("a-b", &alpha, &beta), ("b-c", &beta, &gamma)] {
        let evidence = episode(&mut engine, id, id);
        engine
            .create_entity_relation(CreateEntityRelationRequest {
                scope: scope(),
                source_entity_id: source.id.clone(),
                relation_type: "links".to_owned(),
                target_entity_id: target.id.clone(),
                confidence: 1.0,
                valid_from_ms: None,
                valid_to_ms: None,
                recorded_at_ms: NOW_MS,
                evidence: vec![GraphEvidenceInput {
                    event_id: evidence.event_id,
                    excerpt: None,
                }],
            })
            .expect("edge");
    }
    let target = remember_bound(
        &mut engine,
        "Gamma stores the cobalt deployment key",
        "target",
    );
    engine
        .bind_memory_entity(&target.id, &gamma.id, &scope())
        .expect("bind target");

    let baseline = engine
        .recall(recall_request("Alpha topology origin"))
        .expect("baseline");
    assert!(
        !baseline
            .results
            .iter()
            .any(|result| result.memory.id == target.id)
    );

    let assisted = engine
        .recall_with_graph(GraphRecallRequest {
            recall: recall_request("Alpha topology origin"),
            max_depth: 2,
            max_edges: 10,
            max_entities: 10,
            max_memories: 10,
        })
        .expect("graph recall");
    assert!(
        assisted
            .results
            .iter()
            .any(|result| { result.memory.id == target.id && !result.graph_path.is_empty() })
    );
    assert!(!assisted.graph_truncated);
}

#[test]
fn graph_recall_never_returns_foreign_scope_binding() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let alpha = entity(&mut engine, "Alpha");
    let foreign = remember_bound(&mut engine, "foreign private memory", "foreign");
    let mut foreign_scope = scope();
    foreign_scope.user_id = celiums_memory_engine::UserId::new("other-user").expect("user");

    let result = engine.bind_memory_entity(&foreign.id, &alpha.id, &foreign_scope);
    assert!(result.is_err());
}
