// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Celiums Memory over the Hyphae data engine.
//!
//! Durable, hash-chained, verifiable storage (Hyphae) underneath the
//! cognitive recall model of Celiums Memory (`celiums-cognition`):
//! hybrid exact-cosine + BM25F candidate retrieval re-ranked by the
//! six-channel formula (semantic, text, importance, Ebbinghaus
//! retrievability, emotional weight, PAD resonance under the SAR
//! filter), with spaced-repetition reactivation on recall.
//!
//! Embeddings are caller-provided floats; this crate quantises them to
//! Hyphae's canonical Q15 domain and enforces the dimension guard.

mod affect_state;
mod embed;
mod engine;
mod journal;
mod memory;
mod quantize;

pub use affect_state::AffectState;
pub use embed::deterministic_embed;
pub use engine::{
    BranchAbstention, JournalRecallRequest, JournalWriteRequest, MemoryEngine, MemoryEngineError,
    RecallConfig, RecallRequest, RecallResponse, RememberRequest, ScoredMemory,
};
pub use journal::{BrokenLink, BrokenReason, ChainReport, JournalEntry, Supersession, chain_hash};
pub use memory::{Memory, MemoryDecodeError};
pub use quantize::{QuantizeError, quantize};
