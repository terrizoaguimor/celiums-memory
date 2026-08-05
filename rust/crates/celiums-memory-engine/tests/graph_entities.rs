// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Canonical entity identity, aliases, ontology, merge and split semantics.

mod support;

use celiums_memory_engine::{
    CreateEntityRequest, DefineEntityTypeRequest, EntityAliasRequest, EntityLineageRequest,
    EntityLineageType, EntityResolution, GraphEvidenceInput, RecallScope, UserId,
};

use support::{NOW_MS, episode, open};

fn scope() -> RecallScope {
    support::scope()
}

#[test]
fn canonical_entity_and_alias_survive_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let entity;
    {
        let mut engine = open(&dir);
        let evidence = episode(&mut engine, "event-1", "Mario Gutierrez founded Celiums");
        entity = engine
            .create_entity(CreateEntityRequest {
                scope: scope(),
                entity_type: "person".to_owned(),
                canonical_label: "Mario Gutierrez".to_owned(),
                recorded_at_ms: NOW_MS,
                evidence: vec![GraphEvidenceInput {
                    event_id: evidence.event_id,
                    excerpt: Some("Mario Gutierrez".to_owned()),
                }],
            })
            .expect("entity");
        engine
            .add_entity_alias(EntityAliasRequest {
                scope: scope(),
                entity_id: entity.id.clone(),
                alias: "Mario".to_owned(),
                valid_from_ms: Some(NOW_MS),
                valid_to_ms: None,
                recorded_at_ms: NOW_MS,
                evidence: Vec::new(),
            })
            .expect("alias");
    }

    let engine = open(&dir);
    assert_eq!(
        engine
            .resolve_entity_alias(&scope(), "person", "mario", NOW_MS, NOW_MS)
            .expect("resolve"),
        EntityResolution::Resolved(entity.id)
    );
}

#[test]
fn aliases_are_scoped_and_ambiguity_is_explicit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first_evidence = episode(&mut engine, "event-1", "Mario Gutierrez is founder");
    let second_evidence = episode(&mut engine, "event-2", "Mario Rossi is advisor");
    let first = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "person".to_owned(),
            canonical_label: "Mario Gutierrez".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: first_evidence.event_id,
                excerpt: None,
            }],
        })
        .expect("first");
    let second = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "person".to_owned(),
            canonical_label: "Mario Rossi".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: second_evidence.event_id,
                excerpt: None,
            }],
        })
        .expect("second");
    for entity_id in [first.id.clone(), second.id.clone()] {
        engine
            .add_entity_alias(EntityAliasRequest {
                scope: scope(),
                entity_id,
                alias: "Mario".to_owned(),
                valid_from_ms: None,
                valid_to_ms: None,
                recorded_at_ms: NOW_MS,
                evidence: Vec::new(),
            })
            .expect("alias");
    }

    let resolution = engine
        .resolve_entity_alias(&scope(), "person", "Mario", NOW_MS, NOW_MS)
        .expect("resolution");
    assert_eq!(
        resolution,
        EntityResolution::Ambiguous(vec![first.id, second.id])
    );

    let mut foreign = scope();
    foreign.user_id = UserId::new("other-user").expect("user");
    assert_eq!(
        engine
            .resolve_entity_alias(&foreign, "person", "Mario", NOW_MS, NOW_MS)
            .expect("foreign"),
        EntityResolution::NotFound
    );
}

#[test]
fn custom_ontology_type_survives_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let mut engine = open(&dir);
        engine
            .define_entity_type(DefineEntityTypeRequest {
                scope: scope(),
                type_id: "organization".to_owned(),
                ontology_version: "v2".to_owned(),
                recorded_at_ms: NOW_MS,
            })
            .expect("type");
    }

    let engine = open(&dir);
    assert!(
        engine
            .entity_types(&scope())
            .expect("types")
            .iter()
            .any(|entity_type| {
                entity_type.type_id == "organization" && entity_type.ontology_version == "v2"
            })
    );
}

#[test]
fn merge_resolves_to_target_and_split_remains_ambiguous() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let evidence = episode(&mut engine, "event-1", "Celiums AI is Celiums Solutions");
    let source = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: "Celiums AI".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id.clone(),
                excerpt: None,
            }],
        })
        .expect("source");
    let target = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: "Celiums Solutions".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id.clone(),
                excerpt: None,
            }],
        })
        .expect("target");
    engine
        .record_entity_lineage(EntityLineageRequest {
            scope: scope(),
            source_entity_id: source.id.clone(),
            target_entity_ids: vec![target.id.clone()],
            lineage_type: EntityLineageType::MergedInto,
            effective_at_ms: NOW_MS,
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id.clone(),
                excerpt: None,
            }],
        })
        .expect("merge");
    assert_eq!(
        engine
            .resolve_entity_id(&source.id, &scope(), NOW_MS, NOW_MS)
            .expect("merge resolution"),
        EntityResolution::Resolved(target.id.clone())
    );

    let second_target = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: "Celiums Research".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id.clone(),
                excerpt: None,
            }],
        })
        .expect("second target");
    let third_target = engine
        .create_entity(CreateEntityRequest {
            scope: scope(),
            entity_type: "project".to_owned(),
            canonical_label: "Celiums SaaS".to_owned(),
            recorded_at_ms: NOW_MS,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id.clone(),
                excerpt: None,
            }],
        })
        .expect("third target");
    engine
        .record_entity_lineage(EntityLineageRequest {
            scope: scope(),
            source_entity_id: target.id.clone(),
            target_entity_ids: vec![second_target.id.clone(), third_target.id],
            lineage_type: EntityLineageType::SplitInto,
            effective_at_ms: NOW_MS + 1,
            recorded_at_ms: NOW_MS + 1,
            evidence: vec![GraphEvidenceInput {
                event_id: evidence.event_id,
                excerpt: None,
            }],
        })
        .expect("split");
    assert!(matches!(
        engine
            .resolve_entity_id(&target.id, &scope(), NOW_MS + 1, NOW_MS + 1)
            .expect("split resolution"),
        EntityResolution::Ambiguous(_)
    ));
}
