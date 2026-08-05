// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Deterministic scoped graph traversal with explicit budgets.

mod support;

use celiums_memory_engine::{
    CreateEntityRelationRequest, CreateEntityRequest, DefineRelationTypeRequest,
    GraphEvidenceInput, GraphTraversalRequest, GraphTruncationReason, RelationDirection,
};

use support::{NOW_MS, episode, open, scope};

fn entity(
    engine: &mut celiums_memory_engine::MemoryEngine,
    id: &str,
) -> celiums_memory_engine::CanonicalEntity {
    let event = episode(engine, id, id);
    engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: id.to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: event.event_id,
                excerpt: Some(id.to_owned()),
            }],
        })
        .expect("entity")
}

fn edge(
    engine: &mut celiums_memory_engine::MemoryEngine,
    id: &str,
    source: &celiums_memory_engine::CanonicalEntity,
    target: &celiums_memory_engine::CanonicalEntity,
) {
    let event = episode(engine, id, id);
    engine
        .create_entity_relation(CreateEntityRelationRequest {
            scope: scope(),
            source_entity_id: source.id.clone(),
            relation_type: "links".to_owned(),
            target_entity_id: target.id.clone(),
            confidence: 1.0,
            valid_from_ms: Some(NOW_MS),
            valid_to_ms: None,
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: event.event_id,
                excerpt: Some(id.to_owned()),
            }],
        })
        .expect("edge");
}

fn define_links(engine: &mut celiums_memory_engine::MemoryEngine) {
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
}

#[test]
fn traversal_follows_two_hops_deterministically() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    define_links(&mut engine);
    let a = entity(&mut engine, "A");
    let b = entity(&mut engine, "B");
    let c = entity(&mut engine, "C");
    edge(&mut engine, "A-B", &a, &b);
    edge(&mut engine, "B-C", &b, &c);

    let request = GraphTraversalRequest {
        scope: scope(),
        seeds: vec![a.id.clone()],
        relation_types: Vec::new(),
        valid_at_ms: NOW_MS,
        known_at_ms: NOW_MS,
        max_depth: 2,
        max_edges: 10,
        max_entities: 10,
    };
    let first = engine.traverse_graph(request.clone()).expect("traverse");
    let second = engine.traverse_graph(request).expect("repeat");

    assert_eq!(first, second);
    assert_eq!(first.entities, vec![a.id, b.id, c.id]);
    assert_eq!(first.edges.len(), 2);
    assert!(!first.truncated);
}

#[test]
fn traversal_reports_depth_and_edge_budget_truncation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    define_links(&mut engine);
    let a = entity(&mut engine, "A");
    let b = entity(&mut engine, "B");
    let c = entity(&mut engine, "C");
    edge(&mut engine, "A-B", &a, &b);
    edge(&mut engine, "B-C", &b, &c);

    let depth = engine
        .traverse_graph(GraphTraversalRequest {
            scope: scope(),
            seeds: vec![a.id.clone()],
            relation_types: Vec::new(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
            max_depth: 1,
            max_edges: 10,
            max_entities: 10,
        })
        .expect("depth");
    assert!(depth.truncated);
    assert_eq!(depth.truncation_reason, Some(GraphTruncationReason::Depth));
    assert!(!depth.entities.contains(&c.id));

    let edges = engine
        .traverse_graph(GraphTraversalRequest {
            scope: scope(),
            seeds: vec![a.id],
            relation_types: Vec::new(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
            max_depth: 3,
            max_edges: 1,
            max_entities: 10,
        })
        .expect("edges");
    assert!(edges.truncated);
    assert_eq!(edges.truncation_reason, Some(GraphTruncationReason::Edges));
    assert_eq!(edges.edges.len(), 1);
}

#[test]
fn cycle_terminates_and_foreign_scope_is_invisible() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    define_links(&mut engine);
    let a = entity(&mut engine, "A");
    let b = entity(&mut engine, "B");
    edge(&mut engine, "A-B", &a, &b);
    edge(&mut engine, "B-A", &b, &a);

    let result = engine
        .traverse_graph(GraphTraversalRequest {
            scope: scope(),
            seeds: vec![a.id.clone()],
            relation_types: Vec::new(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
            max_depth: 10,
            max_edges: 10,
            max_entities: 10,
        })
        .expect("cycle");
    assert_eq!(result.entities.len(), 2);
    assert_eq!(result.edges.len(), 2);

    let mut foreign = scope();
    foreign.user_id = celiums_memory_engine::UserId::new("other-user").expect("user");
    assert!(matches!(
        engine.traverse_graph(GraphTraversalRequest {
            scope: foreign,
            seeds: vec![a.id],
            relation_types: Vec::new(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
            max_depth: 10,
            max_edges: 10,
            max_entities: 10,
        }),
        Err(celiums_memory_engine::MemoryEngineError::GraphEntityNotFound { .. })
    ));
}
