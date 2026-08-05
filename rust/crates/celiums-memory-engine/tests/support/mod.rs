// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    ClaimEvidenceInput, ClaimEvidenceRelation, CreateClaimRequest, IngestEventRequest,
    IngestionEntry, MemoryEngine, MemoryIdentity, RecallConfig, SourceEventId, SourceKind,
    SourceNamespace, TenantId, UserId,
};

pub const NOW_MS: i64 = 1_770_000_000_000;
pub const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const DIMENSION: u16 = 4;

pub fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open")
}

pub fn episode(engine: &mut MemoryEngine, source_event_id: &str, content: &str) -> IngestionEntry {
    engine
        .ingest_event(IngestEventRequest {
            source_namespace: SourceNamespace::new("temporal-test").expect("namespace"),
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
            event_at_ms: Some(NOW_MS),
            ingested_at_ms: NOW_MS,
            embedding: None,
            embedding_space: None,
            tags: Vec::new(),
            scope: Scope::Global,
            importance: None,
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("episode")
}

pub fn claim_request(
    episode: &IngestionEntry,
    subject: &str,
    predicate: &str,
    value: &str,
    valid_from_ms: i64,
    valid_to_ms: Option<i64>,
) -> CreateClaimRequest {
    CreateClaimRequest {
        scope: episode.scope(),
        subject: subject.to_owned(),
        predicate: predicate.to_owned(),
        value: value.to_owned(),
        confidence: 0.9,
        valid_from_ms: Some(valid_from_ms),
        valid_to_ms,
        recorded_at_ms: episode.first_ingested_at_ms,
        evidence: vec![ClaimEvidenceInput {
            event_id: episode.event_id.clone(),
            relation: ClaimEvidenceRelation::Supports,
            excerpt: None,
        }],
    }
}
