// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! MCP session behaviour end-to-end against a real embedded engine:
//! handshake, tool listing, remember/recall round trip, journal tools,
//! and error paths — all through the JSON-RPC surface.

use std::io::{BufReader, Cursor};

use celiums_memory_cli::mcp::Session;
use celiums_memory_engine::{MemoryEngine, RecallConfig};
use serde_json::{Value, json};

const DIMENSION: u16 = 256;

fn session(dir: &tempfile::TempDir) -> Session {
    let engine = MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");
    Session::new(engine, DIMENSION, dir.path().to_path_buf())
}

fn initialized_session(dir: &tempfile::TempDir) -> Session {
    let mut session = session(dir);
    let init = session
        .handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" }
            }
        }))
        .expect("initialize response");
    assert_eq!(init["result"]["serverInfo"]["name"], "celiums-memory");
    assert!(
        session
            .handle(&json!({
                "jsonrpc": "2.0", "method": "notifications/initialized"
            }))
            .is_none(),
        "notification must not be answered"
    );
    session
}

fn call(session: &mut Session, tool: &str, arguments: Value) -> Value {
    let response = session
        .handle(&json!({
            "jsonrpc": "2.0", "id": 99, "method": "tools/call",
            "params": { "name": tool, "arguments": arguments }
        }))
        .expect("tool response");
    response["result"].clone()
}

#[test]
fn tools_require_initialization() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = session(&dir);
    let response = session
        .handle(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}
        }))
        .expect("response");
    assert_eq!(response["error"]["code"], -32002);
}

#[test]
fn full_remember_recall_round_trip_over_mcp() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = initialized_session(&dir);

    let tools = session
        .handle(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
        }))
        .expect("tools list");
    assert_eq!(tools["result"]["tools"].as_array().map(Vec::len), Some(17));

    let remembered = call(
        &mut session,
        "remember",
        json!({
            "content": "Decidimos portar Celiums Memory a Rust sobre Hyphae",
            "tenant_id": "local",
            "user_id": "mario",
            "agent_id": "agent-sol",
            "project_id": "celiums-memory",
            "conversation_id": "conversation-1",
            "session_id": "session-1",
            "source_kind": "user",
            "source_id": "message-1",
            "source_uri": "mcp://conversation-1/message-1",
            "actor": "Mario",
            "event_at_ms": 1_770_000_000_000_i64,
            "embedding_provider": "celiums",
            "embedding_model": "deterministic-word-bigram-hash",
            "embedding_revision": "v1"
        }),
    );
    assert_eq!(remembered["isError"], false);
    assert!(
        remembered["structuredContent"]["importance"]
            .as_f64()
            .unwrap_or(0.0)
            > 0.1
    );
    assert_eq!(
        remembered["structuredContent"]["identity"]["tenant_id"],
        "local"
    );
    assert_eq!(
        remembered["structuredContent"]["identity"]["project_id"],
        "celiums-memory"
    );
    assert_eq!(
        remembered["structuredContent"]["provenance"]["source_id"],
        "message-1"
    );
    assert_eq!(
        remembered["structuredContent"]["embedding_space"]["model"],
        "deterministic-word-bigram-hash"
    );
    assert_eq!(
        remembered["structuredContent"]["provenance"]["content_hash"]
            .as_str()
            .map(str::len),
        Some(64)
    );

    let recalled = call(
        &mut session,
        "recall",
        json!({
            "query": "portar Celiums Memory a Rust",
            "tenant_id": "local",
            "user_id": "mario",
            "project_id": "celiums-memory",
            "conversation_id": "conversation-1",
            "session_id": "session-1",
            "embedding_provider": "celiums",
            "embedding_model": "deterministic-word-bigram-hash",
            "embedding_revision": "v1"
        }),
    );
    assert_eq!(recalled["isError"], false);
    let results = recalled["structuredContent"]["results"]
        .as_array()
        .expect("results");
    assert!(!results.is_empty(), "the memory must come back");
    assert!(
        results[0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("Rust")
    );
    assert_eq!(results[0]["identity"]["tenant_id"], "local");
    assert_eq!(results[0]["provenance"]["source_kind"], "user");
    assert_eq!(results[0]["event_at_ms"], 1_770_000_000_000_i64);
    assert_eq!(results[0]["embedding_space"]["revision"], "v1");

    let id = remembered["structuredContent"]["id"].as_str().expect("id");
    let got = call(
        &mut session,
        "memory_get",
        json!({"id":id,"tenant_id":"local","user_id":"mario","project_id":"celiums-memory"}),
    );
    assert_eq!(got["structuredContent"]["memory"]["revision"], 1);
    let updated = call(
        &mut session,
        "memory_update",
        json!({
            "id":id,"if_revision":1,"tenant_id":"local","user_id":"mario",
            "project_id":"celiums-memory","patch":{"importance":0.9,"tags":["updated"]}
        }),
    );
    assert_eq!(updated["structuredContent"]["memory"]["revision"], 2);
    let listed = call(
        &mut session,
        "memory_list",
        json!({"tenant_id":"local","user_id":"mario","project_id":"celiums-memory"}),
    );
    assert_eq!(listed["structuredContent"]["matched"], 1);
    let deleted = call(
        &mut session,
        "memory_delete",
        json!({"id":id,"tenant_id":"local","user_id":"mario","project_id":"celiums-memory"}),
    );
    assert_eq!(deleted["structuredContent"]["deleted"], true);
    assert!(results[0]["channels"]["semantic"].is_number(), "glass box");
}

#[test]
fn journal_tools_chain_and_verify_over_mcp() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = initialized_session(&dir);

    let first = call(
        &mut session,
        "journal_write",
        json!({
            "agent_id": "Codex-opus-4-8",
            "entry_type": "decision",
            "content": "El MCP server queda embebido, sin HTTP interno",
            "valence": 0.7
        }),
    );
    assert_eq!(first["isError"], false);
    assert!(first["structuredContent"]["prev_hash"].is_null(), "genesis");

    let second = call(
        &mut session,
        "journal_write",
        json!({
            "agent_id": "Codex-opus-4-8",
            "entry_type": "lesson",
            "content": "El chain hash cubre id, agente, contenido y tiempo"
        }),
    );
    assert_eq!(
        second["structuredContent"]["prev_hash"], first["structuredContent"]["hash"],
        "entries must chain"
    );

    let verify = call(
        &mut session,
        "journal_verify_chain",
        json!({ "agent_id": "Codex-opus-4-8" }),
    );
    assert_eq!(verify["structuredContent"]["valid"], true);
    assert_eq!(verify["structuredContent"]["total"], 2);

    let recall = call(
        &mut session,
        "journal_recall",
        json!({ "agent_id": "Codex-opus-4-8", "query": "chain hash" }),
    );
    let entries = recall["structuredContent"]["entries"]
        .as_array()
        .expect("entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["entry_type"], "lesson");
}

#[test]
fn stats_report_count_and_affect_label() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = initialized_session(&dir);
    call(
        &mut session,
        "remember",
        json!({ "content": "una memoria cualquiera para contar" }),
    );
    let stats = call(&mut session, "memory_stats", json!({}));
    assert_eq!(stats["structuredContent"]["memories"], 1);
    assert!(stats["structuredContent"]["affect"]["label"].is_string());
}

#[test]
fn tool_errors_are_reported_not_crashed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = initialized_session(&dir);

    // Missing required field.
    let missing = call(&mut session, "remember", json!({}));
    assert_eq!(missing["isError"], true);

    // Invalid agent id is refused with the P0 contract message.
    let invalid = call(
        &mut session,
        "journal_write",
        json!({
            "agent_id": "agente con espacios",
            "entry_type": "reflection",
            "content": "no debe persistir"
        }),
    );
    assert_eq!(invalid["isError"], true);

    // Wrong embedding dimension fails loudly, never degrades.
    let wrong_dim = call(
        &mut session,
        "remember",
        json!({ "content": "texto", "embedding": [0.5, 0.5] }),
    );
    assert_eq!(wrong_dim["isError"], true);
    assert!(
        wrong_dim["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("dimension"),
    );

    // Unknown tool is a protocol error.
    let unknown = session
        .handle(&json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} }
        }))
        .expect("response");
    assert_eq!(unknown["error"]["code"], -32602);
}

#[test]
fn phase2_tools_work_over_mcp() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = initialized_session(&dir);

    // Day 1 belief + snapshot.
    call(
        &mut session,
        "remember",
        json!({ "content": "Mario Gutierrez decided the architecture is TypeScript with Postgres" }),
    );
    let snap = call(&mut session, "snapshot_now", json!({}));
    assert_eq!(snap["isError"], false);
    let sequence = snap["structuredContent"]["checkpoint_sequence"]
        .as_u64()
        .expect("sequence");

    // Day 2 reversal.
    call(
        &mut session,
        "remember",
        json!({ "content": "Mario Gutierrez decided to abandon Postgres for rust on Hyphae" }),
    );

    // Entity graph sees both memories bound to the person.
    let lookup = call(
        &mut session,
        "entity_lookup",
        json!({ "name": "Mario Gutierrez", "entity_kind": "person" }),
    );
    assert_eq!(
        lookup["structuredContent"]["memories"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );

    // Time-travel to day 1: only the old belief.
    let past = call(
        &mut session,
        "recall_at",
        json!({ "query": "architecture decision", "checkpoint_sequence": sequence }),
    );
    assert_eq!(past["isError"], false);
    let results = past["structuredContent"]["results"]
        .as_array()
        .expect("results");
    assert!(!results.is_empty());
    assert!(
        results.iter().all(|r| !r["content"]
            .as_str()
            .unwrap_or_default()
            .contains("abandon")),
        "day 1 must not know the day-2 reversal"
    );

    // Consolidation over MCP.
    let consolidated = call(
        &mut session,
        "consolidate",
        json!({ "text": "user: We settled on Hyphae snapshots for point-in-time recall going forward" }),
    );
    assert_eq!(consolidated["structuredContent"]["created"], 1);

    // Lifecycle runs (nothing to archive this young).
    let lifecycle = call(&mut session, "run_lifecycle", json!({}));
    assert_eq!(lifecycle["isError"], false);
}

#[test]
fn stdio_loop_answers_over_buffered_transport() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut session = session(&dir);

    let requests = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        "\n",
    );
    let mut input = BufReader::new(Cursor::new(requests.as_bytes().to_vec()));
    let mut output = Vec::new();
    session.run(&mut input, &mut output).expect("session run");

    let lines: Vec<Value> = output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).expect("valid JSON"))
        .collect();
    assert_eq!(lines.len(), 2, "initialize + tools/list answers");
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[1]["id"], 2);
    assert!(lines[1]["result"]["tools"].is_array());
}
