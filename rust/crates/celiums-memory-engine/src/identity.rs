// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Canonical identity and provenance carried by durable memories.

use std::fmt;

use thiserror::Error;

const MAX_ID_BYTES: usize = 255;

/// Invalid canonical identity.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{kind} must be 1..={MAX_ID_BYTES} bytes and contain no control characters")]
pub struct InvalidIdentity {
    kind: &'static str,
}

macro_rules! identity {
    ($name:ident, $kind:literal) => {
        #[doc = concat!("Canonical ", $kind, ".")]
        #[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Validates and creates a ", $kind, ".")]
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidIdentity> {
                let value = value.into();
                if value.is_empty()
                    || value.trim() != value
                    || value.len() > MAX_ID_BYTES
                    || value.chars().any(char::is_control)
                {
                    return Err(InvalidIdentity { kind: $kind });
                }
                Ok(Self(value))
            }

            /// Returns the canonical string value.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

identity!(TenantId, "tenant id");
identity!(UserId, "user id");
identity!(AgentId, "agent id");
identity!(ProjectId, "project id");
identity!(ConversationId, "conversation id");
identity!(SessionId, "session id");

/// Security and query scope attached to a memory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryIdentity {
    /// Owning tenant. The service resolves this; callers never choose it freely.
    pub tenant_id: TenantId,
    /// Owning user within the tenant.
    pub user_id: UserId,
    /// Agent that observed the memory, when known.
    pub agent_id: Option<AgentId>,
    /// Project boundary, when known.
    pub project_id: Option<ProjectId>,
    /// Conversation boundary, when known.
    pub conversation_id: Option<ConversationId>,
    /// Session boundary, when known.
    pub session_id: Option<SessionId>,
}

/// Required caller scope for recall inside one tenant store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecallScope {
    /// Tenant bound to the engine/store.
    pub tenant_id: TenantId,
    /// User whose memories may be returned.
    pub user_id: UserId,
    /// Current project, required for project-scoped memories.
    pub project_id: Option<ProjectId>,
    /// Current conversation, available for future fine-grained policies.
    pub conversation_id: Option<ConversationId>,
    /// Current session, required for session-scoped memories.
    pub session_id: Option<SessionId>,
}

impl RecallScope {
    /// Local single-user recall scope used by stdio callers that omit identity.
    pub fn local() -> Self {
        let identity = MemoryIdentity::local();
        Self {
            tenant_id: identity.tenant_id,
            user_id: identity.user_id,
            project_id: None,
            conversation_id: None,
            session_id: None,
        }
    }
}

impl MemoryIdentity {
    /// Local single-user identity used by the stdio server.
    pub fn local() -> Self {
        Self {
            tenant_id: TenantId::new("local").expect("static identity"),
            user_id: UserId::new("local").expect("static identity"),
            agent_id: None,
            project_id: None,
            conversation_id: None,
            session_id: None,
        }
    }
}

/// Origin class of a memory observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceKind {
    /// Direct user-authored content.
    User,
    /// Assistant-authored content.
    Assistant,
    /// Tool output or tool event.
    Tool,
    /// Imported document or file.
    Document,
    /// System-generated event.
    System,
    /// Dataset or evaluation fixture.
    Benchmark,
    /// Older record created before provenance was available.
    Legacy,
}

impl SourceKind {
    /// Stable serialized name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
            Self::Document => "document",
            Self::System => "system",
            Self::Benchmark => "benchmark",
            Self::Legacy => "legacy",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "tool" => Some(Self::Tool),
            "document" => Some(Self::Document),
            "system" => Some(Self::System),
            "benchmark" => Some(Self::Benchmark),
            "legacy" => Some(Self::Legacy),
            _ => None,
        }
    }
}

/// Trace from a durable memory back to the observation that produced it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Provenance {
    /// Origin class.
    pub source_kind: SourceKind,
    /// Stable upstream event or message identifier.
    pub source_id: Option<String>,
    /// Source URI, when the observation came from an addressable resource.
    pub source_uri: Option<String>,
    /// Actor or speaker label supplied by the integration.
    pub actor: Option<String>,
    /// BLAKE3 of the exact content bytes written to the engine.
    pub content_hash: String,
}

impl Provenance {
    /// Creates provenance and computes the content hash inside the trust boundary.
    pub fn observed(
        source_kind: SourceKind,
        content: &str,
        source_id: Option<String>,
        source_uri: Option<String>,
        actor: Option<String>,
    ) -> Self {
        Self {
            source_kind,
            source_id,
            source_uri,
            actor,
            content_hash: blake3::hash(content.as_bytes()).to_hex().to_string(),
        }
    }

    pub(crate) fn legacy(content: &str) -> Self {
        Self::observed(SourceKind::Legacy, content, None, None, None)
    }
}

/// Identity, origin and clocks supplied to a remember operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RememberContext {
    /// Security and query identity.
    pub identity: MemoryIdentity,
    /// Origin metadata.
    pub provenance: Provenance,
    /// When the represented event occurred, if known.
    pub event_at_ms: Option<i64>,
    /// When the engine ingested the observation.
    pub ingested_at_ms: i64,
}

impl RememberContext {
    /// Local stdio context for direct observations.
    pub fn local(content: &str, ingested_at_ms: i64) -> Self {
        Self {
            identity: MemoryIdentity::local(),
            provenance: Provenance::observed(SourceKind::User, content, None, None, None),
            event_at_ms: None,
            ingested_at_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_reject_empty_control_and_oversized_values() {
        assert!(TenantId::new("").is_err());
        assert!(TenantId::new(" tenant").is_err());
        assert!(TenantId::new("tenant ").is_err());
        assert!(UserId::new("bad\nuser").is_err());
        assert!(ProjectId::new("x".repeat(256)).is_err());
        assert_eq!(AgentId::new("agent-1").expect("valid").as_str(), "agent-1");
    }

    #[test]
    fn content_hash_is_stable_and_content_sensitive() {
        let first = Provenance::observed(SourceKind::User, "hello", None, None, None);
        let same = Provenance::observed(SourceKind::User, "hello", None, None, None);
        let other = Provenance::observed(SourceKind::User, "hello!", None, None, None);

        assert_eq!(first.content_hash, same.content_hash);
        assert_ne!(first.content_hash, other.content_hash);
        assert_eq!(first.content_hash.len(), 64);
    }
}
