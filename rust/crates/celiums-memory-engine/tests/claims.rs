// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Claims are durable knowledge derived from, but separate from, raw episodes.

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    ClaimEvidenceInput, ClaimEvidenceRelation, CreateClaimRequest, IngestEventRequest,
    MemoryEngine, MemoryIdentity, RecallConfig, SourceEventId, SourceKind, SourceNamespace,
    TenantId, UserId,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open")
}

fn raw_event(source_event_id: &str, content: &str) -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new("opencode").expect("namespace"),
        source_event_id: SourceEventId::new(source_event_id).expect("event"),
        turn_id: None,
        source_kind: SourceKind::User,
        source_uri: None,
        actor: Some("Mario".to_owned()),
        identity: MemoryIdentity {
            tenant_id: TenantId::new("tenant-a").expect("tenant"),
            user_id: UserId::new("mario").expect("user"),
            agent_id: None,
            project_id: None,
            conversation_id: None,
            session_id: None,
        },
        content: content.to_owned(),
        event_at_ms: Some(NOW_MS - 1_000),
        ingested_at_ms: NOW_MS,
        embedding: None,
        embedding_space: None,
        tags: vec!["episode".to_owned()],
        scope: Scope::Global,
        importance: None,
        content_role: ContentRole::Observation,
        purpose: MemoryPurpose::ConversationalContext,
    }
}

#[test]
fn claim_and_evidence_are_separate_records_without_mutating_raw_episode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let episode = engine
        .ingest_event(raw_event("event-1", "Mario lives in Medellin"))
        .expect("episode");
    let before = episode.clone();

    let claim = engine
        .create_claim(CreateClaimRequest {
            scope: episode.scope(),
            subject: "Mario".to_owned(),
            predicate: "lives_in".to_owned(),
            value: "Medellin".to_owned(),
            confidence: 0.95,
            valid_from_ms: Some(NOW_MS - 1_000),
            valid_to_ms: None,
            recorded_at_ms: NOW_MS,
            evidence: vec![ClaimEvidenceInput {
                event_id: episode.event_id.clone(),
                relation: ClaimEvidenceRelation::Supports,
                excerpt: Some("lives in Medellin".to_owned()),
            }],
        })
        .expect("claim");

    assert_ne!(claim.id.as_str(), episode.event_id.as_str());
    assert_eq!(claim.subject, "Mario");
    assert_eq!(claim.predicate, "lives_in");
    assert_eq!(claim.value, "Medellin");
    assert_eq!(claim.evidence_count, 1);
    assert_eq!(engine.count().expect("memory count"), 0);
    assert_eq!(
        engine
            .get_ingestion(&episode.event_id, &episode.scope())
            .expect("episode lookup")
            .expect("episode"),
        before
    );

    let evidence = engine
        .claim_evidence(&claim.id, &episode.scope())
        .expect("evidence");
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0].event_id, episode.event_id);
    assert_eq!(evidence[0].relation, ClaimEvidenceRelation::Supports);
}

#[test]
fn claim_retry_is_deterministic_and_survives_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let claim;
    let request;
    {
        let mut engine = open(&dir);
        let episode = engine
            .ingest_event(raw_event("event-2", "The deployment region is nyc1"))
            .expect("episode");
        request = CreateClaimRequest {
            scope: episode.scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            value: "nyc1".to_owned(),
            confidence: 1.0,
            valid_from_ms: Some(NOW_MS),
            valid_to_ms: None,
            recorded_at_ms: NOW_MS,
            evidence: vec![ClaimEvidenceInput {
                event_id: episode.event_id,
                relation: ClaimEvidenceRelation::Supports,
                excerpt: None,
            }],
        };
        claim = engine.create_claim(request.clone()).expect("claim");
        assert_eq!(engine.create_claim(request.clone()).expect("retry"), claim);
    }

    let mut engine = open(&dir);
    assert_eq!(engine.create_claim(request).expect("reopen retry"), claim);
    assert_eq!(
        engine
            .get_claim(&claim.id, &claim.scope)
            .expect("lookup")
            .expect("claim"),
        claim
    );
}

#[test]
fn claim_requires_visible_durable_evidence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let episode = engine
        .ingest_event(raw_event("event-3", "Evidence belongs to Mario"))
        .expect("episode");
    let mut foreign_scope = episode.scope();
    foreign_scope.user_id = UserId::new("other-user").expect("user");

    let result = engine.create_claim(CreateClaimRequest {
        scope: foreign_scope,
        subject: "Mario".to_owned(),
        predicate: "owns".to_owned(),
        value: "evidence".to_owned(),
        confidence: 0.8,
        valid_from_ms: None,
        valid_to_ms: None,
        recorded_at_ms: NOW_MS,
        evidence: vec![ClaimEvidenceInput {
            event_id: episode.event_id,
            relation: ClaimEvidenceRelation::Supports,
            excerpt: None,
        }],
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::ClaimEvidenceNotFound { .. })
    ));
}

#[test]
fn claim_rejects_excerpt_not_present_in_immutable_episode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let episode = engine
        .ingest_event(raw_event("event-4", "The deployment region is nyc1"))
        .expect("episode");

    let result = engine.create_claim(CreateClaimRequest {
        scope: episode.scope(),
        subject: "deployment".to_owned(),
        predicate: "region".to_owned(),
        value: "sfo3".to_owned(),
        confidence: 0.8,
        valid_from_ms: None,
        valid_to_ms: None,
        recorded_at_ms: NOW_MS,
        evidence: vec![ClaimEvidenceInput {
            event_id: episode.event_id,
            relation: ClaimEvidenceRelation::Supports,
            excerpt: Some("region is sfo3".to_owned()),
        }],
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::ClaimEvidenceExcerptMismatch { .. })
    ));
}
