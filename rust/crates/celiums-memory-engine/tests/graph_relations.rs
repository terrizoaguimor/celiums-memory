// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Typed temporal entity relations with immutable evidence.

mod support;

use celiums_memory_engine::{
    CreateEntityRelationRequest, CreateEntityRequest, DefineRelationTypeRequest,
    GraphEvidenceInput, RelationDirection,
};

use support::{DAY_MS, NOW_MS, episode, open, scope};

fn entity(
    engine: &mut celiums_memory_engine::MemoryEngine,
    source_id: &str,
    label: &str,
    entity_type: &str,
) -> celiums_memory_engine::CanonicalEntity {
    let evidence = episode(engine, source_id, label);
    engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: entity_type.to_owned(),
            canonical_label: label.to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id,
                excerpt: Some(label.to_owned()),
            }],
        })
        .expect("entity")
}

#[test]
fn typed_relation_preserves_validity_ontology_and_evidence_across_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let relation;
    {
        let mut engine = open(&dir);
        let person = entity(&mut engine, "person", "Mario Gutierrez", "person");
        let project = entity(&mut engine, "project", "Celiums Memory", "project");
        let evidence = episode(
            &mut engine,
            "relation",
            "Mario Gutierrez founded Celiums Memory",
        );
        engine
            .define_relation_type(DefineRelationTypeRequest {
                scope: scope(),
                relation_type: "founded".to_owned(),
                source_entity_types: vec!["person".to_owned()],
                target_entity_types: vec!["project".to_owned()],
                direction: RelationDirection::Directed,
                traversable: true,
                ontology_version: "v1".to_owned(),
                recorded_at_ms: NOW_MS,
            })
            .expect("relation type");
        relation = engine
            .create_entity_relation(CreateEntityRelationRequest {
                scope: scope(),
                source_entity_id: person.id,
                relation_type: "founded".to_owned(),
                target_entity_id: project.id,
                confidence: 0.95,
                valid_from_ms: Some(NOW_MS),
                valid_to_ms: None,
                recorded_at_ms: NOW_MS,
                evidence: vec![GraphEvidenceInput {
                    event_id: evidence.event_id,
                    excerpt: Some("founded".to_owned()),
                }],
            })
            .expect("relation");
    }

    let engine = open(&dir);
    let visible = engine
        .entity_relations_at(&scope(), NOW_MS, NOW_MS)
        .expect("relations");
    assert_eq!(visible, vec![relation.clone()]);
    assert_eq!(relation.ontology_version, "v1");
    assert_eq!(relation.evidence_count, 1);
}

#[test]
fn relation_enforces_endpoint_types_and_source_evidence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let person = entity(&mut engine, "person", "Mario Gutierrez", "person");
    let other_person = entity(&mut engine, "person-2", "Danny Gutierrez", "person");
    engine
        .define_relation_type(DefineRelationTypeRequest {
            scope: scope(),
            relation_type: "founded".to_owned(),
            source_entity_types: vec!["person".to_owned()],
            target_entity_types: vec!["project".to_owned()],
            direction: RelationDirection::Directed,
            traversable: true,
            ontology_version: "v1".to_owned(),
            recorded_at_ms: NOW_MS,
        })
        .expect("type");

    let wrong_type = engine.create_entity_relation(CreateEntityRelationRequest {
        scope: scope(),
        source_entity_id: person.id.clone(),
        relation_type: "founded".to_owned(),
        target_entity_id: other_person.id,
        confidence: 1.0,
        valid_from_ms: None,
        valid_to_ms: None,
        recorded_at_ms: NOW_MS,
        evidence: Vec::new(),
    });
    assert!(matches!(
        wrong_type,
        Err(celiums_memory_engine::MemoryEngineError::GraphRelationEndpointType)
    ));

    let project = entity(&mut engine, "project", "Celiums Memory", "project");
    let no_evidence = engine.create_entity_relation(CreateEntityRelationRequest {
        scope: scope(),
        source_entity_id: person.id,
        relation_type: "founded".to_owned(),
        target_entity_id: project.id,
        confidence: 1.0,
        valid_from_ms: None,
        valid_to_ms: None,
        recorded_at_ms: NOW_MS,
        evidence: Vec::new(),
    });
    assert!(matches!(
        no_evidence,
        Err(celiums_memory_engine::MemoryEngineError::InvalidGraph(_))
    ));
}

#[test]
fn relation_query_is_bitemporal_and_half_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let person = entity(&mut engine, "person", "Mario Gutierrez", "person");
    let project = entity(&mut engine, "project", "Celiums Memory", "project");
    let evidence = episode(&mut engine, "relation", "Mario worked on Celiums Memory");
    engine
        .define_relation_type(DefineRelationTypeRequest {
            scope: scope(),
            relation_type: "worked_on".to_owned(),
            source_entity_types: vec!["person".to_owned()],
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
            source_entity_id: person.id,
            relation_type: "worked_on".to_owned(),
            target_entity_id: project.id,
            confidence: 1.0,
            valid_from_ms: Some(NOW_MS),
            valid_to_ms: Some(NOW_MS + DAY_MS),
            recorded_at_ms: NOW_MS + 1,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id,
                excerpt: None,
            }],
        })
        .expect("relation");

    assert!(
        engine
            .entity_relations_at(&scope(), NOW_MS, NOW_MS)
            .expect("not known")
            .is_empty()
    );
    assert_eq!(
        engine
            .entity_relations_at(&scope(), NOW_MS + DAY_MS - 1, NOW_MS + 1)
            .expect("valid")
            .len(),
        1
    );
    assert!(
        engine
            .entity_relations_at(&scope(), NOW_MS + DAY_MS, NOW_MS + DAY_MS)
            .expect("expired")
            .is_empty()
    );
}
