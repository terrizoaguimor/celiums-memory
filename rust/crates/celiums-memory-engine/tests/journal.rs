// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! End-to-end behaviour of the per-agent journal: chained writes,
//! recall with supersession, chain verification, isolation between
//! agents, and separation from user memory.

use celiums_cognition::{JournalEntryType, SupersessionRelation};
use celiums_memory_engine::{
    JournalRecallRequest, JournalWriteRequest, MemoryEngine, MemoryEngineError, RecallConfig,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;
const AGENT: &str = "Codex-opus-4-8";

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open")
}

fn write(
    engine: &mut MemoryEngine,
    content: &str,
    entry_type: JournalEntryType,
    at_ms: i64,
) -> celiums_memory_engine::JournalEntry {
    engine
        .journal_write(JournalWriteRequest {
            agent_id: AGENT.to_owned(),
            entry_type,
            content: content.to_owned(),
            preceded_by: vec![],
            valence: Some(0.5),
            valence_reason: None,
            tags: vec![],
            conversation_id: None,
            now_ms: at_ms,
        })
        .expect("journal_write")
}

fn recall(engine: &MemoryEngine, query: &str) -> Vec<celiums_memory_engine::JournalEntry> {
    engine
        .journal_recall(&JournalRecallRequest {
            agent_id: AGENT.to_owned(),
            query: query.to_owned(),
            entry_type: None,
            limit: 10,
            include_superseded: false,
        })
        .expect("journal_recall")
}

#[test]
fn entries_chain_and_verify() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let first = write(
        &mut engine,
        "Decidí usar Hyphae como sustrato",
        JournalEntryType::Decision,
        NOW_MS,
    );
    let second = write(
        &mut engine,
        "Aprendí que el log ya trae hash-chain",
        JournalEntryType::Lesson,
        NOW_MS + 1000,
    );

    assert_eq!(first.prev_hash, None, "genesis has no predecessor");
    assert_eq!(second.prev_hash, Some(first.hash.clone()));

    let report = engine.journal_verify_chain(AGENT).expect("verify");
    assert!(report.valid, "chain must verify: {:?}", report.broken);
    assert_eq!(report.total, 2);
}

#[test]
fn chain_survives_reopen_and_keeps_linking() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first_hash;
    {
        let mut engine = open(&dir);
        first_hash = write(
            &mut engine,
            "antes del reinicio",
            JournalEntryType::Reflection,
            NOW_MS,
        )
        .hash;
    }
    let mut engine = open(&dir);
    let second = write(
        &mut engine,
        "después del reinicio",
        JournalEntryType::Reflection,
        NOW_MS + 5000,
    );
    assert_eq!(second.prev_hash, Some(first_hash));
    assert!(engine.journal_verify_chain(AGENT).expect("verify").valid);
}

#[test]
fn recall_filters_type_and_excludes_superseded() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let old_belief = write(
        &mut engine,
        "Creo que el puerto TS es suficiente",
        JournalEntryType::Belief,
        NOW_MS,
    );
    let lesson = write(
        &mut engine,
        "El puerto a Rust elimina toda la infraestructura",
        JournalEntryType::Lesson,
        NOW_MS + 1000,
    );
    let new_belief = write(
        &mut engine,
        "Creo que Rust embebido es el camino",
        JournalEntryType::Belief,
        NOW_MS + 2000,
    );
    engine
        .journal_supersede(
            AGENT,
            &old_belief.id,
            &new_belief.id,
            SupersessionRelation::Superseded,
            NOW_MS + 3000,
        )
        .expect("supersede");

    // Superseded entries are gone from default recall.
    let beliefs: Vec<String> = recall(&engine, "creo")
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    assert!(beliefs.contains(&new_belief.id));
    assert!(!beliefs.contains(&old_belief.id));

    // ...but come back when explicitly requested.
    let with_superseded = engine
        .journal_recall(&JournalRecallRequest {
            agent_id: AGENT.to_owned(),
            query: String::new(),
            entry_type: Some(JournalEntryType::Belief),
            limit: 10,
            include_superseded: true,
        })
        .expect("recall with superseded");
    assert_eq!(with_superseded.len(), 2);

    // Type filter drops the lesson.
    assert!(
        with_superseded
            .iter()
            .all(|entry| entry.entry_type == JournalEntryType::Belief),
        "type filter must hold"
    );
    let _ = lesson;
}

#[test]
fn empty_query_returns_most_recent_first() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for (index, text) in ["uno", "dos", "tres"].iter().enumerate() {
        write(
            &mut engine,
            text,
            JournalEntryType::Reflection,
            NOW_MS + index as i64 * 1000,
        );
    }
    let entries = recall(&engine, "");
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].content, "tres", "newest first");
    assert_eq!(entries[2].content, "uno");
}

#[test]
fn journals_are_isolated_per_agent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    write(
        &mut engine,
        "nota del codex",
        JournalEntryType::Reflection,
        NOW_MS,
    );
    engine
        .journal_write(JournalWriteRequest {
            agent_id: "otro-agente".to_owned(),
            entry_type: JournalEntryType::Reflection,
            content: "nota del otro".to_owned(),
            preceded_by: vec![],
            valence: None,
            valence_reason: None,
            tags: vec![],
            conversation_id: None,
            now_ms: NOW_MS + 1000,
        })
        .expect("second agent write");

    let mine = recall(&engine, "");
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].content, "nota del codex");

    // Each agent chains independently: both are genesis entries.
    assert!(engine.journal_verify_chain(AGENT).expect("verify").valid);
    assert!(
        engine
            .journal_verify_chain("otro-agente")
            .expect("verify")
            .valid
    );
}

#[test]
fn invalid_agent_ids_are_refused_not_bucketed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let result = engine.journal_write(JournalWriteRequest {
        agent_id: "agent con espacios".to_owned(),
        entry_type: JournalEntryType::Reflection,
        content: "no debería persistir".to_owned(),
        preceded_by: vec![],
        valence: None,
        valence_reason: None,
        tags: vec![],
        conversation_id: None,
        now_ms: NOW_MS,
    });
    assert!(matches!(
        result,
        Err(MemoryEngineError::InvalidAgentId { .. })
    ));
}

#[test]
fn preceded_by_must_reference_existing_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let result = engine.journal_write(JournalWriteRequest {
        agent_id: AGENT.to_owned(),
        entry_type: JournalEntryType::Arc,
        content: "arco sin predecesor real".to_owned(),
        preceded_by: vec!["no-existe".to_owned()],
        valence: None,
        valence_reason: None,
        tags: vec![],
        conversation_id: None,
        now_ms: NOW_MS,
    });
    assert!(matches!(
        result,
        Err(MemoryEngineError::JournalEntryNotFound { .. })
    ));
}

#[test]
fn journal_entries_never_leak_into_memory_recall_or_count() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    write(
        &mut engine,
        "el deploy con wrangler tail salió perfecto",
        JournalEntryType::Reflection,
        NOW_MS,
    );

    // No memories stored: memory count stays zero and memory recall
    // abstains even though the journal text matches the query words.
    assert_eq!(engine.count().expect("count"), 0);
    let response = engine
        .recall(celiums_memory_engine::RecallRequest {
            query_text: "wrangler tail deploy".to_owned(),
            embedding: vec![1.0, 0.0, 0.0, 0.0],
            limit: 10,
            current_state: None,
            now_ms: NOW_MS,
            scope: None,
            embedding_space: None,
            disclosure_authority: celiums_cognition::DisclosureAuthority::Agent,
            disclosure_purpose: celiums_cognition::MemoryPurpose::ConversationalContext,
            options: celiums_memory_engine::RecallOptions::default(),
        })
        .expect("memory recall");
    assert!(response.results.is_empty());
    assert!(response.semantic_abstention.is_some());
    assert!(response.lexical_abstention.is_some());
}

#[test]
fn valence_reason_is_clamped_to_contract_length() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let entry = engine
        .journal_write(JournalWriteRequest {
            agent_id: AGENT.to_owned(),
            entry_type: JournalEntryType::Emotion,
            content: "larga justificación".to_owned(),
            preceded_by: vec![],
            valence: Some(2.5), // clamped to 1.0
            valence_reason: Some("x".repeat(600)),
            tags: vec![],
            conversation_id: None,
            now_ms: NOW_MS,
        })
        .expect("write");
    assert_eq!(entry.valence, Some(1.0));
    assert_eq!(
        entry.valence_reason.as_ref().map(String::len),
        Some(500),
        "valence_reason clamps at 500 chars"
    );
}
