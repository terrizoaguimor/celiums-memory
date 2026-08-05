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
mod capture;
mod circadian_state;
mod claim;
mod embed;
mod embedding_space;
mod engine;
mod entity_index;
mod filter;
mod governance_audit;
mod governance_state;
mod idempotency;
mod identity;
mod ingestion;
mod journal;
mod memory;
mod quantize;
mod timetravel;

pub use affect_state::AffectState;
pub use capture::{CaptureAdapter, CaptureEvent};
pub use circadian_state::CircadianState;
pub use claim::{
    Claim, ClaimContradiction, ClaimContradictionKind, ClaimDecodeError, ClaimEvidence,
    ClaimEvidenceInput, ClaimEvidenceRelation, ClaimId, ClaimSupersession,
    ClaimSupersessionRelation, CreateClaimRequest, InvalidClaim, SupersedeClaimRequest,
};
pub use embed::deterministic_embed;
pub use embedding_space::{EmbeddingNormalization, EmbeddingSpaceIdentity, InvalidEmbeddingSpace};
pub use engine::{
    ActionDecision, BatchRememberOutcome, BranchAbstention, CircadianStatus, ConsolidationReport,
    DeleteMemoryOutcome, EnrichEventRequest, IngestBatchRequest, IngestConversationRequest,
    IngestEventRequest, JournalRecallRequest, JournalWriteRequest, LifecycleReport,
    ListMemoriesRequest, MemoryEngine, MemoryEngineError, MemoryPage, MemoryPatch, RecallConfig,
    RecallRequest, RecallResponse, RememberRequest, ScoredMemory, UpdateMemoryRequest,
};
pub use entity_index::EntityRecord;
pub use filter::{
    FilterOperator, FilterValue, MemoryField, MemoryFilter, MemoryFilterError, MemoryPredicate,
};
pub use governance_audit::{
    AuditChainReport, AuditDecision, EthicsAuditEntry, FeedbackEntry, FeedbackKind,
    FeedbackResolution, GovernedOperation, ReviewDisposition, ReviewState, verify_audit_chain,
};
pub use governance_state::MemoryGovernance;
pub use idempotency::{IdempotencyDecodeError, IdempotencyKey, InvalidIdempotencyKey};
pub use identity::{
    AgentId, ConversationId, InvalidIdentity, MemoryIdentity, ProjectId, Provenance, RecallScope,
    RememberContext, SessionId, SourceKind, TenantId, UserId,
};
pub use ingestion::{
    BatchId, BatchItemOutcome, BatchStatus, EventId, IngestionBatch, IngestionCoverage,
    IngestionDecodeError, IngestionEntry, IngestionStatus, InvalidIngestionIdentity, SourceEventId,
    SourceNamespace, TurnId,
};
pub use journal::{BrokenLink, BrokenReason, ChainReport, JournalEntry, Supersession, chain_hash};
pub use memory::{Memory, MemoryDecodeError};
pub use quantize::{QuantizeError, quantize};
pub use timetravel::{SnapshotPoint, recall_at, snapshot_points};
