// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Entity extraction: the actors and objects a memory binds to.
//!
//! Port of `importance.ts` `extractEntities` (lines 314-349): three
//! rule-based extractors (capitalised multi-word names, a technology
//! keyword set, URLs) with fixed salience per kind. Deliberately
//! LLM-free — the engine must classify offline; richer extraction can
//! layer on top as a BYO provider later.

use std::sync::LazyLock;

use regex::Regex;

/// Kind of extracted entity, mirroring the TS union that the three
/// extractors actually produce.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityKind {
    /// Capitalised multi-word name.
    Person,
    /// Known technology keyword.
    Technology,
    /// URL (likely a project or reference).
    Project,
}

impl EntityKind {
    /// Canonical lowercase name, identical to the TS values.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Technology => "technology",
            Self::Project => "project",
        }
    }

    /// Parses the canonical lowercase name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "person" => Some(Self::Person),
            "technology" => Some(Self::Technology),
            "project" => Some(Self::Project),
            _ => None,
        }
    }
}

/// One extracted entity.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtractedEntity {
    /// Entity name as it appeared (people keep their casing; tech
    /// keywords and URLs are stored as matched).
    pub name: String,
    /// Extractor kind.
    pub kind: EntityKind,
    /// Fixed salience per kind (importance.ts:325,334,344).
    pub salience: f64,
}

/// Technology keywords (importance.ts:301-306).
static TECH_KEYWORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    vec![
        "react",
        "vue",
        "angular",
        "svelte",
        "nextjs",
        "typescript",
        "python",
        "go",
        "rust",
        "java",
        "kotlin",
        "swift",
        "docker",
        "kubernetes",
        "terraform",
        "aws",
        "gcp",
        "azure",
        "postgresql",
        "mongodb",
        "redis",
        "qdrant",
        "fastapi",
        "django",
        "flask",
        "nodejs",
        "graphql",
        "grpc",
        "websocket",
        "gemma",
        "llama",
        "gpt",
        "claude",
        "openai",
        "anthropic",
    ]
});

static NAME_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b").expect("static regex"));
static URL_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"https?://\S+").expect("static regex"));

/// Extracts entities from `text` (importance.ts:314-349).
///
/// Deduplicates case-insensitively across extractors, in the same
/// order as the original: names first, then technologies, then URLs.
pub fn extract_entities(text: &str) -> Vec<ExtractedEntity> {
    let mut entities = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    for capture in NAME_PATTERN.captures_iter(text) {
        let name = capture[1].to_owned();
        if seen.insert(name.to_lowercase()) {
            entities.push(ExtractedEntity {
                name,
                kind: EntityKind::Person,
                salience: 0.7,
            });
        }
    }

    let lower = text.to_lowercase();
    for word in lower.split(|c: char| c.is_whitespace() || ",./()[]{}<>".contains(c)) {
        if TECH_KEYWORDS.contains(&word) && seen.insert(word.to_owned()) {
            entities.push(ExtractedEntity {
                name: word.to_owned(),
                kind: EntityKind::Technology,
                salience: 0.5,
            });
        }
    }

    for matched in URL_PATTERN.find_iter(text) {
        let url = matched.as_str().to_owned();
        if seen.insert(url.to_lowercase()) {
            entities.push(ExtractedEntity {
                name: url,
                kind: EntityKind::Project,
                salience: 0.4,
            });
        }
    }

    entities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_people_technologies_and_urls() {
        let entities = extract_entities(
            "Mario Gutierrez moved the Rust engine to https://celiums.io yesterday",
        );
        assert!(entities.contains(&ExtractedEntity {
            name: "Mario Gutierrez".to_owned(),
            kind: EntityKind::Person,
            salience: 0.7,
        }));
        assert!(entities.contains(&ExtractedEntity {
            name: "rust".to_owned(),
            kind: EntityKind::Technology,
            salience: 0.5,
        }));
        assert!(entities.contains(&ExtractedEntity {
            name: "https://celiums.io".to_owned(),
            kind: EntityKind::Project,
            salience: 0.4,
        }));
    }

    #[test]
    fn deduplicates_case_insensitively() {
        let entities = extract_entities("Rust and rust and RUST again with Docker docker");
        let rust_count = entities.iter().filter(|e| e.name == "rust").count();
        assert_eq!(rust_count, 1);
        let docker_count = entities.iter().filter(|e| e.name == "docker").count();
        assert_eq!(docker_count, 1);
    }

    #[test]
    fn plain_text_yields_nothing() {
        assert!(extract_entities("the weather was mild today").is_empty());
    }

    #[test]
    fn kinds_round_trip() {
        for kind in [
            EntityKind::Person,
            EntityKind::Technology,
            EntityKind::Project,
        ] {
            assert_eq!(EntityKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(EntityKind::parse("planet"), None);
    }
}
