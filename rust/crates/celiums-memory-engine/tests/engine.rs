// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! End-to-end behaviour of the memory engine over a real Hyphae data
//! directory: remember, hybrid recall, cognitive ranking, spaced
//! repetition, dimension guard, and durability across reopen.

use celiums_cognition::Scope;
use celiums_memory_engine::{
    AgentId, BranchAbstention, ConversationId, EmbeddingNormalization, EmbeddingSpaceIdentity,
    IdempotencyKey, MemoryEngine, MemoryEngineError, MemoryIdentity, ProjectId, Provenance,
    QuantizeError, RecallConfig, RecallRequest, RecallScope, RememberContext, RememberRequest,
    SessionId, SourceKind, TenantId, UserId,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Deterministic toy embedder: four orthogonal-ish topic axes so tests
/// control semantic similarity exactly.
fn embed(rust: f32, coffee: f32, deploy: f32, music: f32) -> Vec<f32> {
    let vector = [rust, coffee, deploy, music];
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm == 0.0 {
        return vector.to_vec();
    }
    vector.iter().map(|v| v / norm).collect()
}

fn remember(
    engine: &mut MemoryEngine,
    content: &str,
    embedding: Vec<f32>,
    at_ms: i64,
) -> celiums_memory_engine::Memory {
    engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding,
            tags: vec![],
            scope: Scope::Project,
            importance: None,
            now_ms: at_ms,
            context: None,
            embedding_space: None,
            idempotency_key: None,
            content_role: celiums_cognition::ContentRole::Observation,
            purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
        })
        .expect("remember must succeed")
}

fn recall_request(query: &str, embedding: Vec<f32>) -> RecallRequest {
    RecallRequest {
        query_text: query.to_owned(),
        embedding,
        limit: 10,
        current_state: None,
        now_ms: NOW_MS,
        scope: None,
        embedding_space: None,
        disclosure_authority: celiums_cognition::DisclosureAuthority::Agent,
        disclosure_purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
    }
}

#[test]
fn remember_then_recall_ranks_the_semantic_match_first() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    remember(
        &mut engine,
        "We decided to port the memory engine to Rust on top of Hyphae",
        embed(1.0, 0.1, 0.0, 0.0),
        NOW_MS - DAY_MS,
    );
    remember(
        &mut engine,
        "The coffee machine on floor two is broken again",
        embed(0.0, 1.0, 0.0, 0.1),
        NOW_MS - DAY_MS,
    );
    remember(
        &mut engine,
        "Deploy checklist: run migrations before restarting the fleet",
        embed(0.0, 0.0, 1.0, 0.0),
        NOW_MS - DAY_MS,
    );

    let response = engine
        .recall(recall_request(
            "porting the engine to Rust",
            embed(0.9, 0.0, 0.1, 0.0),
        ))
        .expect("recall");

    assert!(!response.results.is_empty(), "expected results");
    assert!(
        response.results[0].memory.content.contains("Rust"),
        "top result was: {}",
        response.results[0].memory.content
    );
    assert!(response.semantic_abstention.is_none());
    assert!(response.lexical_abstention.is_none());

    // Glass-box scoring: the winning channels must be visible.
    let top = &response.results[0];
    assert!(top.channels.semantic > 0.5);
    assert!(top.final_score >= 0.15);
}

#[test]
fn identity_provenance_and_source_time_survive_reopen_and_recall() {
    let dir = tempfile::tempdir().expect("tempdir");
    let content = "The canonical implementation is Rust over Hyphae";
    let identity = MemoryIdentity {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("mario").expect("user"),
        agent_id: Some(AgentId::new("sol").expect("agent")),
        project_id: Some(ProjectId::new("celiums-memory").expect("project")),
        conversation_id: Some(ConversationId::new("conversation-1").expect("conversation")),
        session_id: Some(SessionId::new("session-1").expect("session")),
    };
    let provenance = Provenance::observed(
        SourceKind::User,
        content,
        Some("message-1".to_owned()),
        Some("mcp://conversation-1/message-1".to_owned()),
        Some("Mario".to_owned()),
    );
    {
        let mut engine = MemoryEngine::open_for_tenant(
            dir.path(),
            DIMENSION,
            RecallConfig::default(),
            TenantId::new("tenant-a").expect("tenant"),
        )
        .expect("open");
        engine
            .remember(RememberRequest {
                content: content.to_owned(),
                embedding: embed(1.0, 0.0, 0.0, 0.0),
                tags: vec![],
                scope: Scope::Project,
                importance: None,
                now_ms: NOW_MS,
                context: Some(RememberContext {
                    identity: identity.clone(),
                    provenance: provenance.clone(),
                    event_at_ms: Some(NOW_MS - DAY_MS),
                    ingested_at_ms: NOW_MS,
                }),
                embedding_space: None,
                idempotency_key: None,
                content_role: celiums_cognition::ContentRole::Observation,
                purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
            })
            .expect("remember");
    }

    let mut engine = MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("reopen");
    let mut request = recall_request("canonical implementation", embed(1.0, 0.0, 0.0, 0.0));
    request.scope = Some(RecallScope {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("mario").expect("user"),
        project_id: Some(ProjectId::new("celiums-memory").expect("project")),
        conversation_id: Some(ConversationId::new("conversation-1").expect("conversation")),
        session_id: Some(SessionId::new("session-1").expect("session")),
    });
    let response = engine.recall(request).expect("recall");
    let recalled = &response.results[0].memory;
    assert_eq!(recalled.identity, identity);
    assert_eq!(recalled.provenance, provenance);
    assert_eq!(recalled.event_at_ms, Some(NOW_MS - DAY_MS));
    assert_eq!(recalled.ingested_at_ms, NOW_MS);
}

#[test]
fn remember_rejects_forged_provenance_hash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");
    let mut context = RememberContext::local("different content", NOW_MS);
    context.provenance.source_id = Some("message-1".to_owned());

    let result = engine.remember(RememberRequest {
        content: "actual content".to_owned(),
        embedding: embed(1.0, 0.0, 0.0, 0.0),
        tags: vec![],
        scope: Scope::Project,
        importance: None,
        now_ms: NOW_MS,
        context: Some(context),
        embedding_space: None,
        idempotency_key: None,
        content_role: celiums_cognition::ContentRole::Observation,
        purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
    });

    assert!(matches!(
        result,
        Err(MemoryEngineError::ContentHashMismatch)
    ));
    assert_eq!(engine.count().expect("count"), 0);
}

fn scoped_context(
    content: &str,
    tenant: &str,
    user: &str,
    project: Option<&str>,
    session: Option<&str>,
) -> RememberContext {
    RememberContext {
        identity: MemoryIdentity {
            tenant_id: TenantId::new(tenant).expect("tenant"),
            user_id: UserId::new(user).expect("user"),
            agent_id: None,
            project_id: project.map(|id| ProjectId::new(id).expect("project")),
            conversation_id: None,
            session_id: session.map(|id| SessionId::new(id).expect("session")),
        },
        provenance: Provenance::observed(SourceKind::User, content, None, None, None),
        event_at_ms: None,
        ingested_at_ms: NOW_MS,
    }
}

#[test]
fn physical_tenant_boundary_rejects_cross_tenant_writes_and_recalls() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open");

    let write = engine.remember(RememberRequest {
        content: "tenant B secret".to_owned(),
        embedding: embed(1.0, 0.0, 0.0, 0.0),
        tags: vec![],
        scope: Scope::Global,
        importance: None,
        now_ms: NOW_MS,
        context: Some(scoped_context(
            "tenant B secret",
            "tenant-b",
            "user",
            None,
            None,
        )),
        embedding_space: None,
        idempotency_key: None,
        content_role: celiums_cognition::ContentRole::Observation,
        purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
    });
    assert!(matches!(
        write,
        Err(MemoryEngineError::TenantMismatch { .. })
    ));
    assert_eq!(engine.count().expect("count"), 0);

    let mut request = recall_request("secret", embed(1.0, 0.0, 0.0, 0.0));
    request.scope = Some(RecallScope {
        tenant_id: TenantId::new("tenant-b").expect("tenant"),
        user_id: UserId::new("user").expect("user"),
        project_id: None,
        conversation_id: None,
        session_id: None,
    });
    assert!(matches!(
        engine.recall(request),
        Err(MemoryEngineError::TenantMismatch { .. })
    ));
}

#[test]
fn recall_scope_enforces_user_project_and_session_visibility() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open");
    for (content, user, project, session, scope) in [
        ("global visible", "alice", None, None, Scope::Global),
        (
            "project alpha",
            "alice",
            Some("alpha"),
            None,
            Scope::Project,
        ),
        ("project beta", "alice", Some("beta"), None, Scope::Project),
        (
            "session one",
            "alice",
            Some("alpha"),
            Some("s1"),
            Scope::Session,
        ),
        (
            "session two",
            "alice",
            Some("alpha"),
            Some("s2"),
            Scope::Session,
        ),
        ("bob global", "bob", None, None, Scope::Global),
    ] {
        engine
            .remember(RememberRequest {
                content: content.to_owned(),
                embedding: embed(1.0, 0.0, 0.0, 0.0),
                tags: vec![],
                scope,
                importance: Some(1.0),
                now_ms: NOW_MS,
                context: Some(scoped_context(content, "tenant-a", user, project, session)),
                embedding_space: None,
                idempotency_key: None,
                content_role: celiums_cognition::ContentRole::Observation,
                purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
            })
            .expect("remember");
    }

    let mut request = recall_request("visible project session", embed(1.0, 0.0, 0.0, 0.0));
    request.scope = Some(RecallScope {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("alice").expect("user"),
        project_id: Some(ProjectId::new("alpha").expect("project")),
        conversation_id: None,
        session_id: Some(SessionId::new("s1").expect("session")),
    });
    let response = engine.recall(request).expect("recall");
    let contents: Vec<&str> = response
        .results
        .iter()
        .map(|entry| entry.memory.content.as_str())
        .collect();

    assert!(contents.contains(&"global visible"));
    assert!(contents.contains(&"project alpha"));
    assert!(contents.contains(&"session one"));
    assert!(!contents.contains(&"project beta"));
    assert!(!contents.contains(&"session two"));
    assert!(!contents.contains(&"bob global"));
}

#[test]
fn recall_reactivates_top_results_spaced_repetition() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    let stored = remember(
        &mut engine,
        "Rust ownership prevents data races at compile time",
        embed(1.0, 0.0, 0.0, 0.0),
        NOW_MS - DAY_MS,
    );
    assert_eq!(stored.retrieval_count, 0);
    let initial_importance = stored.importance;

    let response = engine
        .recall(recall_request("rust data races", embed(1.0, 0.0, 0.0, 0.0)))
        .expect("recall");
    let recalled = &response.results[0].memory;

    assert_eq!(recalled.retrieval_count, 1);
    assert!(recalled.importance > initial_importance);
    assert!(recalled.strength > 1.0);
    assert_eq!(recalled.last_retrieved_at_ms, NOW_MS);

    // The reactivation must be durable, not just in the response.
    let second = engine
        .recall(recall_request("rust data races", embed(1.0, 0.0, 0.0, 0.0)))
        .expect("second recall");
    assert_eq!(second.results[0].memory.retrieval_count, 2);
}

fn embedding_space(model: &str, revision: &str) -> EmbeddingSpaceIdentity {
    EmbeddingSpaceIdentity::new(
        "test-provider",
        model,
        revision,
        DIMENSION,
        EmbeddingNormalization::L2,
    )
    .expect("embedding identity")
}

#[test]
fn idempotent_remember_survives_reopen_and_conflicts_on_changed_request() {
    let dir = tempfile::tempdir().expect("tempdir");
    let content = "idempotent writes return the original memory";
    let key = IdempotencyKey::new("request-1").expect("key");
    let first;
    {
        let mut engine =
            MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");
        first = engine
            .remember(RememberRequest {
                content: content.to_owned(),
                embedding: embed(1.0, 0.0, 0.0, 0.0),
                tags: vec!["idempotent".to_owned()],
                scope: Scope::Global,
                importance: Some(0.8),
                now_ms: NOW_MS,
                context: None,
                embedding_space: None,
                idempotency_key: Some(key.clone()),
                content_role: celiums_cognition::ContentRole::Observation,
                purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
            })
            .expect("first write");
        let retry = engine
            .remember(RememberRequest {
                content: content.to_owned(),
                embedding: embed(1.0, 0.0, 0.0, 0.0),
                tags: vec!["idempotent".to_owned()],
                scope: Scope::Global,
                importance: Some(0.8),
                now_ms: NOW_MS + DAY_MS,
                context: None,
                embedding_space: None,
                idempotency_key: Some(key.clone()),
                content_role: celiums_cognition::ContentRole::Observation,
                purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
            })
            .expect("retry");
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.created_at_ms, first.created_at_ms);
        assert_eq!(engine.count().expect("count"), 1);
    }

    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("reopen");
    let retry = engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding: embed(1.0, 0.0, 0.0, 0.0),
            tags: vec!["idempotent".to_owned()],
            scope: Scope::Global,
            importance: Some(0.8),
            now_ms: NOW_MS + 2 * DAY_MS,
            context: None,
            embedding_space: None,
            idempotency_key: Some(key.clone()),
            content_role: celiums_cognition::ContentRole::Observation,
            purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
        })
        .expect("reopen retry");
    assert_eq!(retry.id, first.id);
    let conflict = engine.remember(RememberRequest {
        content: "changed payload".to_owned(),
        embedding: embed(1.0, 0.0, 0.0, 0.0),
        tags: vec!["idempotent".to_owned()],
        scope: Scope::Global,
        importance: Some(0.8),
        now_ms: NOW_MS,
        context: None,
        embedding_space: None,
        idempotency_key: Some(key),
        content_role: celiums_cognition::ContentRole::Observation,
        purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
    });
    assert!(matches!(
        conflict,
        Err(MemoryEngineError::IdempotencyConflict)
    ));
    assert_eq!(engine.count().expect("count"), 1);
}

#[test]
fn filtered_crud_and_batch_preserve_scope_revision_and_projection_cleanup() {
    use celiums_memory_engine::{
        FilterOperator, FilterValue, ListMemoriesRequest, MemoryField, MemoryFilter, MemoryPatch,
        MemoryPredicate, UpdateMemoryRequest,
    };

    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open");
    let scope = RecallScope {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("alice").expect("user"),
        project_id: Some(ProjectId::new("alpha").expect("project")),
        conversation_id: None,
        session_id: None,
    };
    let requests = ["Mario Gutierrez uses Rust", "Alice uses coffee"]
        .into_iter()
        .enumerate()
        .map(|(index, content)| RememberRequest {
            content: content.to_owned(),
            embedding: embed(1.0, 0.0, 0.0, 0.0),
            tags: vec![if index == 0 { "work" } else { "personal" }.to_owned()],
            scope: Scope::Project,
            importance: Some(0.8),
            now_ms: NOW_MS + index as i64,
            context: Some(scoped_context(
                content,
                "tenant-a",
                "alice",
                Some("alpha"),
                None,
            )),
            embedding_space: None,
            idempotency_key: Some(IdempotencyKey::new(format!("batch-{index}")).expect("key")),
            content_role: celiums_cognition::ContentRole::Observation,
            purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
        })
        .collect();
    let outcomes = engine.remember_batch(requests);
    assert!(outcomes.iter().all(|outcome| outcome.result.is_ok()));
    let first = outcomes[0].result.as_ref().expect("first").clone();

    let page = engine
        .list_memories(&ListMemoriesRequest {
            scope: scope.clone(),
            filter: Some(MemoryFilter::Predicate(MemoryPredicate {
                field: MemoryField::Tags,
                operator: FilterOperator::Contains,
                value: Some(FilterValue::String("work".to_owned())),
            })),
            limit: 50,
        })
        .expect("list");
    assert_eq!(page.matched, 1);
    assert_eq!(page.memories[0].id, first.id);

    let updated = engine
        .update_memory(UpdateMemoryRequest {
            id: first.id.clone(),
            scope: scope.clone(),
            patch: MemoryPatch {
                importance: Some(0.95),
                tags: Some(vec!["updated".to_owned()]),
                ..MemoryPatch::default()
            },
            if_revision: 1,
            now_ms: NOW_MS + DAY_MS,
        })
        .expect("update")
        .expect("visible");
    assert_eq!(updated.revision, 2);
    assert!(matches!(
        engine.update_memory(UpdateMemoryRequest {
            id: first.id.clone(),
            scope: scope.clone(),
            patch: MemoryPatch {
                importance: Some(0.5),
                ..MemoryPatch::default()
            },
            if_revision: 1,
            now_ms: NOW_MS + DAY_MS,
        }),
        Err(MemoryEngineError::RevisionConflict { .. })
    ));

    assert!(
        !engine
            .entity_memories(celiums_cognition::EntityKind::Person, "Mario Gutierrez")
            .expect("entity")
            .is_empty()
    );
    let deleted = engine.delete_memory(&first.id, &scope).expect("delete");
    assert!(deleted.deleted);
    assert!(engine.get_memory(&first.id, &scope).expect("get").is_none());
    assert!(
        engine
            .entity_memories(celiums_cognition::EntityKind::Person, "Mario Gutierrez")
            .expect("entity")
            .is_empty()
    );
    assert!(
        !engine
            .delete_memory(&first.id, &scope)
            .expect("idempotent delete")
            .deleted
    );
}

#[test]
fn embedding_space_identity_is_durable_and_reopen_rejects_mismatch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let configured = embedding_space("model-a", "rev-1");
    {
        let engine = MemoryEngine::open_for_tenant_with_embedding(
            dir.path(),
            RecallConfig::default(),
            TenantId::new("tenant-a").expect("tenant"),
            configured.clone(),
        )
        .expect("open");
        assert_eq!(engine.embedding_space(), &configured);
    }
    assert!(
        MemoryEngine::open_for_tenant_with_embedding(
            dir.path(),
            RecallConfig::default(),
            TenantId::new("tenant-a").expect("tenant"),
            configured,
        )
        .is_ok()
    );
    for incompatible in [
        embedding_space("model-b", "rev-1"),
        embedding_space("model-a", "rev-2"),
    ] {
        assert!(matches!(
            MemoryEngine::open_for_tenant_with_embedding(
                dir.path(),
                RecallConfig::default(),
                TenantId::new("tenant-a").expect("tenant"),
                incompatible,
            ),
            Err(MemoryEngineError::EmbeddingSpaceMismatch { .. })
        ));
    }
}

#[test]
fn write_and_recall_reject_incompatible_embedding_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let incompatible = embedding_space("model-b", "rev-1");
    let mut engine = MemoryEngine::open_for_tenant_with_embedding(
        dir.path(),
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
        embedding_space("model-a", "rev-1"),
    )
    .expect("open");
    let content = "embedding spaces must never mix";
    let write = engine.remember(RememberRequest {
        content: content.to_owned(),
        embedding: embed(1.0, 0.0, 0.0, 0.0),
        tags: vec![],
        scope: Scope::Global,
        importance: None,
        now_ms: NOW_MS,
        context: Some(scoped_context(content, "tenant-a", "alice", None, None)),
        embedding_space: Some(incompatible.clone()),
        idempotency_key: None,
        content_role: celiums_cognition::ContentRole::Observation,
        purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
    });
    assert!(matches!(
        write,
        Err(MemoryEngineError::EmbeddingSpaceMismatch { .. })
    ));
    assert_eq!(engine.count().expect("count"), 0);

    let mut request = recall_request("embedding spaces", embed(1.0, 0.0, 0.0, 0.0));
    request.scope = Some(RecallScope {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("alice").expect("user"),
        project_id: None,
        conversation_id: None,
        session_id: None,
    });
    request.embedding_space = Some(incompatible);
    assert!(matches!(
        engine.recall(request),
        Err(MemoryEngineError::EmbeddingSpaceMismatch { .. })
    ));
}

#[test]
fn dimension_guard_fails_loud_never_degrades() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    let wrong = engine.remember(RememberRequest {
        content: "wrong dimension".to_owned(),
        embedding: vec![1.0, 0.0], // 2 != 4
        tags: vec![],
        scope: Scope::Project,
        importance: None,
        now_ms: NOW_MS,
        context: None,
        embedding_space: None,
        idempotency_key: None,
        content_role: celiums_cognition::ContentRole::Observation,
        purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
    });
    assert!(matches!(
        wrong,
        Err(MemoryEngineError::Quantize(
            QuantizeError::DimensionMismatch {
                expected: DIMENSION,
                got: 2
            }
        ))
    ));

    // Nothing was stored by the failed remember.
    assert_eq!(engine.count().expect("count"), 0);

    // Reopening the same directory with another dimension must fail:
    // the stored space definition wins.
    drop(engine);
    let reopened = MemoryEngine::open(dir.path(), 8, RecallConfig::default());
    assert!(
        reopened.is_err(),
        "reopening with a different dimension must fail loudly"
    );
}

#[test]
fn empty_store_reports_abstentions_not_empty_silence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    let response = engine
        .recall(recall_request("anything at all", embed(1.0, 0.0, 0.0, 0.0)))
        .expect("recall on empty store");

    assert!(response.results.is_empty());
    assert_eq!(
        response.semantic_abstention,
        Some(BranchAbstention::NoCandidates)
    );
    assert_eq!(
        response.lexical_abstention,
        Some(BranchAbstention::NoCandidates)
    );
}

#[test]
fn memories_survive_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let mut engine =
            MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");
        remember(
            &mut engine,
            "Celiums Network runs on Cloudflare Workers",
            embed(0.2, 0.0, 1.0, 0.0),
            NOW_MS - DAY_MS,
        );
    }

    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("reopen");
    assert_eq!(engine.count().expect("count"), 1);

    let response = engine
        .recall(recall_request(
            "where does celiums network run",
            embed(0.2, 0.0, 1.0, 0.0),
        ))
        .expect("recall after reopen");
    assert!(
        response.results[0]
            .memory
            .content
            .contains("Cloudflare Workers")
    );
}

#[test]
fn affect_state_shifts_with_stimuli_and_survives_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let baseline;
    let after_remember;
    {
        let mut engine =
            MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");
        baseline = engine.affect_state(NOW_MS);

        // High-arousal stimulus: profanity (0.3) + "furious" (0.3) +
        // exclamations (0.3) + CAPS (0.1) → raw 1.0 → PAD arousal +1.
        remember(
            &mut engine,
            "wtf!! I hate this, I'm furious — the deploy FAILED again and everything is BROKEN!!",
            embed(0.0, 0.0, 1.0, 0.0),
            NOW_MS,
        );
        after_remember = engine.affect_state(NOW_MS);
        assert!(
            after_remember.pleasure < baseline.pleasure,
            "an angry stimulus must lower pleasure: {} -> {}",
            baseline.pleasure,
            after_remember.pleasure
        );
        assert!(after_remember.arousal > baseline.arousal);
    }

    // The state is durable: a reopened engine remembers how it felt.
    let engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("reopen");
    let reloaded = engine.affect_state(NOW_MS);
    assert!((reloaded.pleasure - after_remember.pleasure).abs() < 1e-9);

    // And it decays toward baseline over idle time (half-life 30 min).
    let hours_later = engine.affect_state(NOW_MS + 6 * 60 * 60 * 1000);
    assert!(hours_later.pleasure > reloaded.pleasure);
    assert!(
        (hours_later.pleasure - 0.1).abs() < 0.01,
        "near homeostatic"
    );
}

#[test]
fn internal_state_records_never_leak_into_recall_or_count() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    // Trigger an affect-state write with no memories stored yet.
    remember(
        &mut engine,
        "I love this breakthrough!! amazing!!",
        embed(1.0, 0.0, 0.0, 0.0),
        NOW_MS,
    );

    // count() sees only the memory, not the limbic state record.
    assert_eq!(engine.count().expect("count"), 1);

    // A recall that matches everything still returns only memories.
    let response = engine
        .recall(recall_request(
            "love amazing breakthrough",
            embed(1.0, 0.0, 0.0, 0.0),
        ))
        .expect("recall");
    assert_eq!(response.results.len(), 1);
    assert!(response.results[0].memory.content.contains("breakthrough"));
}

#[test]
fn lexical_branch_rescues_exact_wording_with_weak_embeddings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    // Embedding points away from the query's, but the words match: the
    // lexical branch must still surface it.
    remember(
        &mut engine,
        "the wrangler tail command streams production logs",
        embed(0.0, 0.0, 0.0, 1.0),
        NOW_MS - DAY_MS,
    );

    let response = engine
        .recall(recall_request(
            "wrangler tail production logs",
            embed(1.0, 0.0, 0.0, 0.0),
        ))
        .expect("recall");

    assert!(
        response
            .results
            .iter()
            .any(|scored| scored.memory.content.contains("wrangler tail")),
        "lexical branch should have rescued the exact-wording memory"
    );
}
