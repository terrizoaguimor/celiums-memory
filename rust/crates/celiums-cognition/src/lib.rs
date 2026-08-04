// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Pure cognitive core of Celiums Memory.
//!
//! This crate is the Rust port of the TypeScript cognitive modules
//! (`importance.ts`, `recall.ts`, `limbic.ts` resonance, `lifecycle.ts`
//! decay). It contains only deterministic math and text analysis:
//! no I/O, no clock reads, no storage. Time always arrives as an
//! explicit argument so callers (and tests) control it.
//!
//! Storage and retrieval live in `celiums-memory-engine`, which layers
//! this crate's scoring on top of the Hyphae data engine.

pub mod affect;
pub mod entities;
pub mod importance;
pub mod journal;
pub mod limbic;
pub mod recall;
pub mod retention;

pub use affect::{
    Pad, classify_memory_type, compute_arousal, compute_dominance, compute_valence, extract_pad,
    resonance,
};
pub use entities::{EntityKind, ExtractedEntity, extract_entities};
pub use importance::{ImportanceSignals, classify_importance, content_boost, score_importance};
pub use journal::{JournalEntryType, SupersessionRelation, is_valid_agent_id};
pub use limbic::{LimbicConfig, MemoryInfluence, average_memory_pad, emotion_label};
pub use recall::{ChannelScores, RecallWeights, sar_beta, score};
pub use retention::{
    ARCHIVE_THRESHOLD, ReactivationOutcome, emotional_weight, lifecycle_decay, reactivate,
    retrievability,
};

/// Kind of memory, mirroring the `memory_type` enum of the TypeScript
/// engine's Postgres schema.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryType {
    /// An event that happened ("today we did X").
    Episodic,
    /// A fact or piece of knowledge.
    Semantic,
    /// How to do something.
    Procedural,
    /// A feeling or preference.
    Emotional,
}

impl MemoryType {
    /// Canonical lowercase name, identical to the TypeScript enum values.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Episodic => "episodic",
            Self::Semantic => "semantic",
            Self::Procedural => "procedural",
            Self::Emotional => "emotional",
        }
    }

    /// Parses the canonical lowercase name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "episodic" => Some(Self::Episodic),
            "semantic" => Some(Self::Semantic),
            "procedural" => Some(Self::Procedural),
            "emotional" => Some(Self::Emotional),
            _ => None,
        }
    }
}

/// Lifecycle state of a memory, mirroring the `memory_state` enum of
/// the TypeScript engine's schema.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MemoryState {
    /// Freshly stored, not yet consolidated.
    #[default]
    Active,
    /// Merged or confirmed by consolidation.
    Consolidated,
    /// Importance decayed below the archive threshold; excluded from
    /// recall until reactivated.
    Archived,
}

impl MemoryState {
    /// Canonical lowercase name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Consolidated => "consolidated",
            Self::Archived => "archived",
        }
    }

    /// Parses the canonical lowercase name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "consolidated" => Some(Self::Consolidated),
            "archived" => Some(Self::Archived),
            _ => None,
        }
    }
}

/// Visibility scope of a memory, mirroring the `memory_scope` enum.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Scope {
    /// Visible only inside one session.
    Session,
    /// Visible inside one project (the TypeScript default).
    #[default]
    Project,
    /// Visible everywhere for the owning user.
    Global,
}

impl Scope {
    /// Canonical lowercase name, identical to the TypeScript enum values.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Global => "global",
        }
    }

    /// Parses the canonical lowercase name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "session" => Some(Self::Session),
            "project" => Some(Self::Project),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    value.max(low).min(high)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_type_round_trips() {
        for kind in [
            MemoryType::Episodic,
            MemoryType::Semantic,
            MemoryType::Procedural,
            MemoryType::Emotional,
        ] {
            assert_eq!(MemoryType::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(MemoryType::parse("unknown"), None);
    }

    #[test]
    fn scope_round_trips_and_defaults_to_project() {
        assert_eq!(Scope::default(), Scope::Project);
        for scope in [Scope::Session, Scope::Project, Scope::Global] {
            assert_eq!(Scope::parse(scope.as_str()), Some(scope));
        }
    }

    #[test]
    fn memory_state_round_trips_and_defaults_to_active() {
        assert_eq!(MemoryState::default(), MemoryState::Active);
        for state in [
            MemoryState::Active,
            MemoryState::Consolidated,
            MemoryState::Archived,
        ] {
            assert_eq!(MemoryState::parse(state.as_str()), Some(state));
        }
    }
}
