// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! P10 local baseline for journal/checkpoint/recovery primitives.

use std::time::Instant;

use celiums_memory_engine::{
    EmbeddingSpaceIdentity, MemoryEngine, MemoryIdentity, RecallConfig, RememberContext, TenantId,
    read_encrypted_backup_artifact, restore_encrypted_backup_artifact,
};

fn main() {
    let source = tempfile::tempdir().expect("source");
    let backup_root = tempfile::tempdir().expect("backup root");
    let restore_root = tempfile::tempdir().expect("restore root");
    let mut engine = MemoryEngine::open_for_tenant_with_embedding(
        source.path(),
        RecallConfig::default(),
        TenantId::new("p10-baseline").expect("tenant"),
        EmbeddingSpaceIdentity::deterministic(256),
    )
    .expect("engine");

    let write_start = Instant::now();
    for index in 0..100 {
        engine
            .remember(celiums_memory_engine::RememberRequest {
                content: format!("P10 checkpoint baseline memory {index}"),
                embedding: celiums_memory_engine::deterministic_embed(
                    &format!("P10 checkpoint baseline memory {index}"),
                    256,
                ),
                tags: vec!["p10-baseline".to_owned()],
                scope: celiums_cognition::Scope::Global,
                importance: Some(0.5),
                now_ms: 1_780_000_000_000 + index,
                context: Some(RememberContext {
                    identity: MemoryIdentity {
                        tenant_id: TenantId::new("p10-baseline").expect("tenant"),
                        user_id: celiums_memory_engine::UserId::new("benchmark").expect("user"),
                        agent_id: None,
                        project_id: None,
                        conversation_id: None,
                        session_id: None,
                    },
                    provenance: celiums_memory_engine::Provenance::observed(
                        celiums_memory_engine::SourceKind::Benchmark,
                        &format!("P10 checkpoint baseline memory {index}"),
                        None,
                        None,
                        None,
                    ),
                    event_at_ms: None,
                    ingested_at_ms: 1_780_000_000_000 + index,
                }),
                embedding_space: None,
                idempotency_key: None,
                content_role: celiums_cognition::ContentRole::Observation,
                purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
            })
            .expect("remember");
    }
    let write_ms = write_start.elapsed().as_secs_f64() * 1000.0;

    let checkpoint_dir = backup_root.path().join("checkpoint");
    let checkpoint_start = Instant::now();
    engine
        .create_encrypted_backup(&checkpoint_dir, &[7_u8; 32])
        .expect("checkpoint");
    let checkpoint_ms = checkpoint_start.elapsed().as_secs_f64() * 1000.0;

    let (descriptor, artifact) = read_encrypted_backup_artifact(&checkpoint_dir).expect("artifact");
    let restore_start = Instant::now();
    let report = restore_encrypted_backup_artifact(
        &artifact,
        restore_root.path().join("restored"),
        &[7_u8; 32],
    )
    .expect("restore");
    let restore_ms = restore_start.elapsed().as_secs_f64() * 1000.0;

    println!("p10_baseline format=1");
    println!("writes.count=100 writes.ms={write_ms:.3}");
    println!(
        "checkpoint.sequence={} checkpoint.bytes={} checkpoint.ms={checkpoint_ms:.3}",
        descriptor.checkpoint_sequence,
        artifact.len()
    );
    println!(
        "restore.records={} restore.vectors={} restore.ms={restore_ms:.3}",
        report.record_count, report.vector_count
    );
}
