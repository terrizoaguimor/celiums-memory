// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Journal entry taxonomy: the first-person notebook of the model.
//!
//! Port of the `agent_journal` entry-type contract
//! (`mcp/journal-tools.ts` schema, `lib/journal-write.ts` importance
//! map). The journal is separate from user memory by design: memories
//! record the user's world; journal entries record the model's inner
//! experience of the work.

/// Kind of journal entry (journal-tools.ts:70-71).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JournalEntryType {
    /// Free-form thinking about the work.
    Reflection,
    /// A closed decision.
    Decision,
    /// Something non-obvious worth re-learning.
    Lesson,
    /// A held belief.
    Belief,
    /// An emotional note.
    Emotion,
    /// A change of criterion over time (links `preceded_by`).
    Arc,
    /// A founded doubt about the approach.
    Doubt,
}

impl JournalEntryType {
    /// Canonical lowercase name, identical to the TypeScript enum.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reflection => "reflection",
            Self::Decision => "decision",
            Self::Lesson => "lesson",
            Self::Belief => "belief",
            Self::Emotion => "emotion",
            Self::Arc => "arc",
            Self::Doubt => "doubt",
        }
    }

    /// Parses the canonical lowercase name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "reflection" => Some(Self::Reflection),
            "decision" => Some(Self::Decision),
            "lesson" => Some(Self::Lesson),
            "belief" => Some(Self::Belief),
            "emotion" => Some(Self::Emotion),
            "arc" => Some(Self::Arc),
            "doubt" => Some(Self::Doubt),
            _ => None,
        }
    }

    /// Intrinsic importance of the entry type
    /// (lib/journal-write.ts:92-98): arcs and decisions matter most.
    pub fn importance(self) -> f64 {
        match self {
            Self::Reflection => 0.6,
            Self::Decision => 0.85,
            Self::Lesson => 0.75,
            Self::Belief => 0.8,
            Self::Emotion => 0.55,
            Self::Arc => 0.9,
            Self::Doubt => 0.65,
        }
    }
}

/// How a new journal entry relates to the entry it supersedes
/// (journal-tools.ts:92).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupersessionRelation {
    /// The old entry no longer holds.
    Superseded,
    /// The old entry holds with nuance.
    Nuanced,
    /// The old entry is confirmed.
    Reaffirmed,
    /// The old entry is retracted.
    Recanted,
}

impl SupersessionRelation {
    /// Canonical lowercase name, identical to the TypeScript enum.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Superseded => "superseded",
            Self::Nuanced => "nuanced",
            Self::Reaffirmed => "reaffirmed",
            Self::Recanted => "recanted",
        }
    }

    /// Parses the canonical lowercase name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "superseded" => Some(Self::Superseded),
            "nuanced" => Some(Self::Nuanced),
            "reaffirmed" => Some(Self::Reaffirmed),
            "recanted" => Some(Self::Recanted),
            _ => None,
        }
    }
}

/// Validates an agent identifier: `[A-Za-z0-9_:.\-]{1,128}`.
///
/// Port of the P0 §3.1 invariant (lib/journal-write.ts:104-131): the
/// journal is isolated per agent, so an unresolvable or malformed
/// agent id must be refused, never funnelled into a shared bucket.
pub fn is_valid_agent_id(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= 128
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_:.-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_types_round_trip_with_importance() {
        for (kind, importance) in [
            (JournalEntryType::Reflection, 0.6),
            (JournalEntryType::Decision, 0.85),
            (JournalEntryType::Lesson, 0.75),
            (JournalEntryType::Belief, 0.8),
            (JournalEntryType::Emotion, 0.55),
            (JournalEntryType::Arc, 0.9),
            (JournalEntryType::Doubt, 0.65),
        ] {
            assert_eq!(JournalEntryType::parse(kind.as_str()), Some(kind));
            assert!((kind.importance() - importance).abs() < 1e-12);
        }
        assert_eq!(JournalEntryType::parse("diary"), None);
    }

    #[test]
    fn supersession_relations_round_trip() {
        for relation in [
            SupersessionRelation::Superseded,
            SupersessionRelation::Nuanced,
            SupersessionRelation::Reaffirmed,
            SupersessionRelation::Recanted,
        ] {
            assert_eq!(
                SupersessionRelation::parse(relation.as_str()),
                Some(relation)
            );
        }
    }

    #[test]
    fn agent_ids_follow_the_p0_contract() {
        assert!(is_valid_agent_id("Codex-opus-4-8"));
        assert!(is_valid_agent_id("claude_3.5:sonnet"));
        assert!(!is_valid_agent_id(""));
        assert!(!is_valid_agent_id("agent with spaces"));
        assert!(!is_valid_agent_id(&"x".repeat(129)));
        assert!(!is_valid_agent_id("agente;DROP TABLE"));
    }
}
