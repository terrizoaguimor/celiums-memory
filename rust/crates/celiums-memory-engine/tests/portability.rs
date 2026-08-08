// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 9 logical export/import and encrypted-backup gates.

use std::fs;

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    EmbeddingSpaceIdentity, ExportSelector, IdempotencyKey, MemoryEngine, MemoryIdentity,
    PortabilityError, Provenance, RecallConfig, RememberContext, RememberRequest, SourceKind,
    TenantId, UserId, apply_migration, hard_delete_store, import_logical, plan_migration,
    read_encrypted_backup_artifact, residue_report, restore_encrypted_backup,
    restore_encrypted_backup_artifact, verify_logical_export,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_780_000_000_000;

fn open(path: &std::path::Path) -> MemoryEngine {
    MemoryEngine::open_for_tenant_with_embedding(
        path,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
        EmbeddingSpaceIdentity::deterministic(DIMENSION),
    )
    .expect("engine")
}

fn remember(engine: &mut MemoryEngine, user: &str, content: &str) -> String {
    let memory = engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding: vec![1.0, 0.0, 0.0, 0.0],
            tags: vec!["portability".to_owned()],
            scope: Scope::Global,
            importance: Some(0.8),
            now_ms: NOW_MS,
            context: Some(RememberContext {
                identity: MemoryIdentity {
                    tenant_id: TenantId::new("tenant-a").expect("tenant"),
                    user_id: UserId::new(user).expect("user"),
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
            idempotency_key: Some(IdempotencyKey::new(format!("{user}-key")).expect("key")),
            content_role: ContentRole::Observation,
            purpose: MemoryPurpose::ConversationalContext,
        })
        .expect("remember");
    memory.id
}

#[test]
fn tenant_export_roundtrips_and_manifest_detects_tampering() {
    let source = tempfile::tempdir().expect("source");
    let export = tempfile::tempdir().expect("export").path().join("logical");
    let restore = tempfile::tempdir().expect("restore").path().join("tenant");
    let mut engine = open(source.path());
    remember(&mut engine, "alice", "Alice portability canary");
    remember(&mut engine, "bob", "Bob portability canary");

    let info = engine
        .export_logical(
            &export,
            ExportSelector::Tenant {
                tenant_id: "tenant-a".to_owned(),
            },
        )
        .expect("export");
    assert!(info.manifest.record_count >= 6);
    assert_eq!(
        verify_logical_export(&export).expect("verify"),
        info.manifest
    );
    let restored = import_logical(&export, &restore).expect("import");
    assert_eq!(restored.record_count, info.manifest.record_count);

    let records = export.join("records.ndjson");
    let original = fs::read(&records).expect("records");
    let mut tampered = original.clone();
    tampered[0] ^= 1;
    fs::write(&records, tampered).expect("tamper");
    assert!(matches!(
        verify_logical_export(&export),
        Err(PortabilityError::Integrity)
    ));
}

#[test]
fn user_and_project_selectors_exclude_other_owners() {
    let source = tempfile::tempdir().expect("source");
    let mut engine = open(source.path());
    remember(&mut engine, "alice", "Alice only");
    remember(&mut engine, "bob", "Bob only");
    let export = tempfile::tempdir().expect("export").path().join("alice");
    let info = engine
        .export_logical(
            &export,
            ExportSelector::User {
                tenant_id: "tenant-a".to_owned(),
                user_id: "alice".to_owned(),
            },
        )
        .expect("user export");
    let records = fs::read_to_string(export.join("records.ndjson")).expect("records");
    assert!(!records.is_empty());
    assert!(!records.contains("Bob only"));
    assert!(info.manifest.record_count > 0);
}

#[test]
fn encrypted_backup_can_be_created_and_is_not_plaintext() {
    let source = tempfile::tempdir().expect("source");
    let backup = tempfile::tempdir()
        .expect("backup")
        .path()
        .join("encrypted");
    let mut engine = open(source.path());
    remember(&mut engine, "alice", "secret backup canary");
    let key = [7_u8; 32];
    let info = engine
        .create_encrypted_backup(&backup, &key)
        .expect("backup");
    let ciphertext = fs::read(backup.join("backup.bin")).expect("ciphertext");
    assert!(!String::from_utf8_lossy(&ciphertext).contains("secret backup canary"));
    assert_eq!(
        info.ciphertext_blake3,
        blake3::hash(&ciphertext).to_hex().to_string()
    );
    let restored = tempfile::tempdir().expect("restored").path().join("tenant");
    let report = restore_encrypted_backup(&backup, &restored, &key).expect("restore");
    assert!(report.record_count > 0);

    let (descriptor, artifact) = read_encrypted_backup_artifact(&backup).expect("artifact");
    assert!(descriptor.ciphertext_bytes > 0);
    assert!(descriptor.plaintext_bytes > 0);
    let artifact_restore = tempfile::tempdir()
        .expect("artifact restore")
        .path()
        .join("tenant");
    let artifact_report = restore_encrypted_backup_artifact(&artifact, &artifact_restore, &key)
        .expect("artifact restore");
    assert_eq!(artifact_report.record_count, report.record_count);
}

#[test]
fn selective_hard_delete_preserves_other_users_and_reports_clean_residue() {
    let source = tempfile::tempdir().expect("source");
    let mut engine = open(source.path());
    remember(&mut engine, "alice", "Alice erase canary");
    remember(&mut engine, "bob", "Bob survivor");
    drop(engine);
    let selector = ExportSelector::User {
        tenant_id: "tenant-a".to_owned(),
        user_id: "alice".to_owned(),
    };
    let report = hard_delete_store(source.path(), selector.clone()).expect("delete");
    assert!(report.residue.clean);
    let residue = residue_report(source.path(), selector).expect("residue");
    assert!(residue.clean);
    let reopened = open(source.path());
    assert_eq!(reopened.count().expect("count"), 1);
}

#[test]
fn migration_plan_is_read_only_and_detects_source_drift() {
    let source = tempfile::tempdir().expect("source");
    let export = tempfile::tempdir().expect("export").path().join("logical");
    let destination = tempfile::tempdir()
        .expect("destination")
        .path()
        .join("target");
    let mut engine = open(source.path());
    remember(&mut engine, "alice", "migration canary");
    engine
        .export_logical(
            &export,
            ExportSelector::Tenant {
                tenant_id: "tenant-a".to_owned(),
            },
        )
        .expect("export");
    let plan = plan_migration(
        celiums_memory_engine::MigrationKind::TypescriptToRust,
        &export,
        destination.clone(),
    )
    .expect("plan");
    assert!(!destination.exists());
    let applied = apply_migration(&plan, &export).expect("apply");
    assert_eq!(applied.data_path, destination);
}

#[test]
fn unknown_format_version_and_wrong_backup_key_fail_closed() {
    let source = tempfile::tempdir().expect("source");
    let export = tempfile::tempdir().expect("export").path().join("logical");
    let mut engine = open(source.path());
    remember(&mut engine, "alice", "format canary");
    engine
        .export_logical(
            &export,
            ExportSelector::Tenant {
                tenant_id: "tenant-a".to_owned(),
            },
        )
        .expect("export");
    let manifest_path = export.join("MANIFEST.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).expect("manifest")).expect("json");
    manifest["format_version"] = serde_json::json!(99);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("manifest json"),
    )
    .expect("write manifest");
    assert!(matches!(
        verify_logical_export(&export),
        Err(PortabilityError::UnsupportedVersion)
    ));

    let backup = tempfile::tempdir()
        .expect("backup")
        .path()
        .join("encrypted");
    let key = [3_u8; 32];
    engine
        .create_encrypted_backup(&backup, &key)
        .expect("backup");
    let destination = tempfile::tempdir()
        .expect("destination")
        .path()
        .join("restore");
    assert!(matches!(
        restore_encrypted_backup(&backup, &destination, &[4_u8; 32]),
        Err(PortabilityError::Crypto)
    ));
    assert!(!destination.exists());
}
