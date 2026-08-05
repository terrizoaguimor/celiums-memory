// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! `celiums-memory` — the single binary.
//!
//! ```text
//! celiums-memory mcp [--data <dir>] [--dimension <n>] [--embedding-provider <id>]
//!   [--embedding-model <id>] [--embedding-revision <id>] [--tenant-id <id>]
//!   [--timezone-offset <min>]
//! ```
//!
//! Runs the MCP stdio server over the embedded engine. Zero external
//! services: one process, one data directory.
//!
//! Without `--timezone-offset` the engine infers the user's timezone
//! from their activity rhythm (and falls back to UTC until it has
//! signal); the flag pins it explicitly (e.g. `-300` for UTC-5).

use celiums_memory_cli::mcp;

use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;
use std::process::ExitCode;

use celiums_memory_engine::{
    EmbeddingNormalization, EmbeddingSpaceIdentity, MemoryEngine, RecallConfig, TenantId,
};

/// Default embedding dimension: the deterministic offline embedder's
/// native size. Callers with a real model pass `--dimension` (bge-m3 =
/// 1024) and provide `embedding` arrays in tool calls.
const DEFAULT_DIMENSION: u16 = 256;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("celiums-memory: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    if command != "mcp" {
        return Err(format!(
            "usage: celiums-memory mcp [--data <dir>] [--dimension <n>] [--embedding-provider <id>] [--embedding-model <id>] [--embedding-revision <id>] [--tenant-id <id>] [--timezone-offset <min>]{}",
            if command.is_empty() {
                ""
            } else {
                "\nunknown command"
            }
        ));
    }

    let mut data_dir: Option<PathBuf> = None;
    let mut dimension = DEFAULT_DIMENSION;
    let mut timezone_offset: Option<i32> = None;
    let mut tenant_id = TenantId::new("local").expect("static identity");
    let mut embedding_provider = "celiums".to_owned();
    let mut embedding_model = "deterministic-word-bigram-hash".to_owned();
    let mut embedding_revision = "v1".to_owned();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--data" => {
                data_dir = Some(PathBuf::from(
                    args.next().ok_or("--data requires a directory path")?,
                ));
            }
            "--dimension" => {
                dimension = args
                    .next()
                    .ok_or("--dimension requires a number")?
                    .parse()
                    .map_err(|_| "--dimension must be a positive integer up to 4096")?;
            }
            "--timezone-offset" => {
                timezone_offset = Some(
                    args.next()
                        .ok_or("--timezone-offset requires minutes east of UTC (e.g. -300)")?
                        .parse()
                        .map_err(|_| "--timezone-offset must be an integer within ±840")?,
                );
                if timezone_offset.is_some_and(|minutes| minutes.abs() > 840) {
                    return Err("--timezone-offset must be within ±840 minutes".to_owned());
                }
            }
            "--tenant-id" => {
                tenant_id = TenantId::new(args.next().ok_or("--tenant-id requires an id")?)
                    .map_err(|error| error.to_string())?;
            }
            "--embedding-provider" => {
                embedding_provider = args.next().ok_or("--embedding-provider requires an id")?;
            }
            "--embedding-model" => {
                embedding_model = args.next().ok_or("--embedding-model requires an id")?;
            }
            "--embedding-revision" => {
                embedding_revision = args.next().ok_or("--embedding-revision requires an id")?;
            }
            other => return Err(format!("unknown flag `{other}`")),
        }
    }
    let data_dir = data_dir.unwrap_or_else(default_data_dir);

    let embedding_space = EmbeddingSpaceIdentity::new(
        embedding_provider,
        embedding_model,
        embedding_revision,
        dimension,
        EmbeddingNormalization::L2,
    )
    .map_err(|error| error.to_string())?;
    let mut engine = MemoryEngine::open_for_tenant_with_embedding(
        &data_dir,
        RecallConfig::default(),
        tenant_id,
        embedding_space,
    )
    .map_err(|error| format!("cannot open data directory {}: {error}", data_dir.display()))?;
    if let Some(minutes) = timezone_offset {
        engine
            .set_timezone_override(Some(minutes), unix_now_ms())
            .map_err(|error| format!("cannot persist timezone override: {error}"))?;
    }

    let mut session = mcp::Session::new(engine, dimension, data_dir);
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    session
        .run(&mut input, &mut output)
        .map_err(|error| error.to_string())
}

fn unix_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// `~/.celiums/memory` (or a local fallback when no home is known).
fn default_data_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(
            || PathBuf::from(".celiums-memory"),
            |home| PathBuf::from(home).join(".celiums").join("memory"),
        )
}
