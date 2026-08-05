// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 5 graph integrity and no-orphan gate.

mod support;

use celiums_memory_engine::{
    CreateEntityRelationRequest, CreateEntityRequest, DefineRelationTypeRequest,
    GraphEvidenceInput, RelationDirection,
};

use support::{NOW_MS, episode, open, scope};

#[test]
fn valid_graph_has_no_orphans_and_survives_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let mut engine = open(&dir);
        let source_event = episode(&mut engine, "source", "Alpha");
        let target_event = episode(&mut engine, "target", "Beta");
        let relation_event = episode(&mut engine, "edge", "Alpha links Beta");
        let source = engine
            .create_entity(CreateEntityRequest {
                scope: scope(),
                entity_type: "project".to_owned(),
                canonical_label: "Alpha".to_owned(),
                recorded_at_ms: NOW_MS,
                evidence: vec![GraphEvidenceInput {
                    event_id: source_event.event_id,
                    excerpt: None,
                }],
            })
            .expect("source");
        let target = engine
            .create_entity(CreateEntityRequest {
                scope: scope(),
                entity_type: "project".to_owned(),
                canonical_label: "Beta".to_owned(),
                recorded_at_ms: NOW_MS,
                evidence: vec![GraphEvidenceInput {
                    event_id: target_event.event_id,
                    excerpt: None,
                }],
            })
            .expect("target");
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
        engine
            .create_entity_relation(CreateEntityRelationRequest {
                scope: scope(),
                source_entity_id: source.id,
                relation_type: "links".to_owned(),
                target_entity_id: target.id,
                confidence: 1.0,
                valid_from_ms: None,
                valid_to_ms: None,
                recorded_at_ms: NOW_MS,
                evidence: vec![GraphEvidenceInput {
                    event_id: relation_event.event_id,
                    excerpt: Some("links".to_owned()),
                }],
            })
            .expect("edge");
    }

    let engine = open(&dir);
    let report = engine.graph_verify(&scope()).expect("verify");
    assert!(report.valid, "{report:?}");
    assert_eq!(report.entity_count, 2);
    assert_eq!(report.relation_count, 1);
    assert!(report.issues.is_empty());
}

#[test]
fn deleting_bound_memory_removes_graph_binding() {
    use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
    use celiums_memory_engine::{
        IdempotencyKey, MemoryIdentity, Provenance, RememberContext, RememberRequest, SourceKind,
        deterministic_embed,
    };

    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let event = episode(&mut engine, "entity", "Alpha");
    let entity = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: "Alpha".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: event.event_id,
                excerpt: None,
            }],
        })
        .expect("entity");
    let content = "Alpha internal memory";
    let memory = engine
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
                provenance: Provenance::observed(SourceKind::User, content, None, None, None),
                event_at_ms: None,
                ingested_at_ms: NOW_MS,
            }),
            embedding_space: None,
            idempotency_key: Some(IdempotencyKey::new("memory-1").expect("key")),
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("memory");
    engine
        .bind_memory_entity(&memory.id, &entity.id, &scope())
        .expect("bind");
    engine
        .delete_memory(&memory.id, &scope())
        .expect("delete memory");

    let report = engine.graph_verify(&scope()).expect("verify");
    assert!(report.valid, "{report:?}");
    assert_eq!(report.binding_count, 0);
}
