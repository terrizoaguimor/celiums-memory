// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! `celiums-memory` — the single binary.
//!
//! ```text
//! celiums-memory mcp [--data <dir>] [--dimension <n>]
//! ```
//!
//! Runs the MCP stdio server over the embedded engine. Zero external
//! services: one process, one data directory.

use celiums_memory_cli::mcp;

use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;
use std::process::ExitCode;

use celiums_memory_engine::{MemoryEngine, RecallConfig};

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
            "usage: celiums-memory mcp [--data <dir>] [--dimension <n>]{}",
            if command.is_empty() {
                ""
            } else {
                "\nunknown command"
            }
        ));
    }

    let mut data_dir: Option<PathBuf> = None;
    let mut dimension = DEFAULT_DIMENSION;
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
            other => return Err(format!("unknown flag `{other}`")),
        }
    }
    let data_dir = data_dir.unwrap_or_else(default_data_dir);

    let engine = MemoryEngine::open(&data_dir, dimension, RecallConfig::default())
        .map_err(|error| format!("cannot open data directory {}: {error}", data_dir.display()))?;

    let mut session = mcp::Session::new(engine, dimension);
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    session
        .run(&mut input, &mut output)
        .map_err(|error| error.to_string())
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
