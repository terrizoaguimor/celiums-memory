// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 7 gate: fixed-budget evidence, duplicate control and frozen determinism.

mod support;

use celiums_cognition::{ContentRole, DisclosureAuthority, MemoryPurpose, Scope};
use celiums_memory_engine::{ContextComposeRequest, RecallOptions, RecallRequest, RememberRequest};

use support::{NOW_MS, open, scope};

fn request(query: &str, limit: usize) -> RecallRequest {
    RecallRequest {
        query_text: query.to_owned(),
        embedding: celiums_memory_engine::deterministic_embed(query, 4),
        limit,
        current_state: None,
        now_ms: NOW_MS,
        scope: Some(scope()),
        embedding_space: None,
        disclosure_authority: DisclosureAuthority::Owner,
        disclosure_purpose: MemoryPurpose::ConversationalContext,
        options: RecallOptions::default(),
    }
}

fn remember(engine: &mut celiums_memory_engine::MemoryEngine, content: &str) {
    engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding: celiums_memory_engine::deterministic_embed(content, 4),
            tags: Vec::new(),
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
        .expect("remember");
}

#[test]
fn fixed_budget_context_improves_evidence_density_without_duplicates() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for _ in 0..3 {
        remember(&mut engine, "Celiums production runtime is Cloudflare");
    }
    remember(&mut engine, "Hyphae is the canonical storage substrate");
    remember(&mut engine, "The unrelated coffee machine is broken");

    let baseline = engine
        .recall(request("Celiums Cloudflare Hyphae storage", 5))
        .expect("baseline");
    let context = engine
        .compose_context(ContextComposeRequest {
            recall: request("Celiums Cloudflare Hyphae storage", 5),
            token_budget: 24,
        })
        .expect("context");

    assert!(baseline.results.len() >= context.sections.len());
    assert!(context.estimated_tokens <= 24);
    assert!(context.rendered.contains("Cloudflare"));
    assert!(context.rendered.contains("Hyphae"));
    let baseline_tokens = baseline
        .results
        .iter()
        .filter_map(|result| result.disclosed_content.as_deref())
        .map(|content| {
            content
                .split_whitespace()
                .map(|word| word.len().div_ceil(4).max(1))
                .sum::<usize>()
        })
        .sum::<usize>();
    let baseline_unique = baseline
        .results
        .iter()
        .map(|result| result.citations[0].memory_id.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .len() as u64;
    let baseline_density = baseline_unique.saturating_mul(1_000) / baseline_tokens.max(1) as u64;
    assert!(context.evidence_density_milli >= baseline_density);
    let hashes = context
        .sections
        .iter()
        .map(|section| section.citations[0].content_hash.clone())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(hashes.len(), context.sections.len());
}

#[test]
fn frozen_recall_and_context_leave_full_durable_state_unchanged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    remember(&mut engine, "Cloudflare Workers host the canonical service");
    let before_memory = engine
        .list_memories(&celiums_memory_engine::ListMemoriesRequest {
            scope: scope(),
            filter: None,
            limit: 10,
        })
        .expect("before memories");
    let before_affect = engine.affect_snapshot();

    let first = engine
        .compose_context(ContextComposeRequest {
            recall: request("Cloudflare canonical service", 5),
            token_budget: 32,
        })
        .expect("first");
    let second = engine
        .compose_context(ContextComposeRequest {
            recall: request("Cloudflare canonical service", 5),
            token_budget: 32,
        })
        .expect("second");

    assert_eq!(first, second);
    assert_eq!(engine.affect_snapshot(), before_affect);
    assert_eq!(
        engine
            .list_memories(&celiums_memory_engine::ListMemoriesRequest {
                scope: scope(),
                filter: None,
                limit: 10,
            })
            .expect("after memories")
            .memories,
        before_memory.memories
    );
}
