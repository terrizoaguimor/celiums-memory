// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Transport-neutral normalization for coding-agent and webhook capture.

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};

use crate::{
    IngestEventRequest, MemoryIdentity, SourceEventId, SourceKind, SourceNamespace, TurnId,
};

/// Supported capture integrations.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureAdapter {
    /// OpenCode and Codex continuity hooks.
    OpenCodeCodex,
    /// Claude Code hooks.
    ClaudeCode,
    /// Cursor hooks.
    Cursor,
    /// Any MCP client that emits source events.
    Mcp,
    /// Generic signed/authorized webhook transport.
    Webhook,
}

impl CaptureAdapter {
    /// Stable namespace used in deterministic event identity.
    pub fn namespace(self) -> &'static str {
        match self {
            Self::OpenCodeCodex => "opencode-codex",
            Self::ClaudeCode => "claude-code",
            Self::Cursor => "cursor",
            Self::Mcp => "mcp",
            Self::Webhook => "webhook",
        }
    }
}

/// One adapter-neutral capture envelope.
#[derive(Clone, Debug)]
pub struct CaptureEvent {
    /// Adapter that received the event.
    pub adapter: CaptureAdapter,
    /// Stable host event or message ID.
    pub source_event_id: SourceEventId,
    /// Optional host turn/group ID.
    pub turn_id: Option<TurnId>,
    /// Actor role or source class.
    pub source_kind: SourceKind,
    /// Optional address back to the host event.
    pub source_uri: Option<String>,
    /// Optional actor label.
    pub actor: Option<String>,
    /// Tenant/user/project/conversation ownership.
    pub identity: MemoryIdentity,
    /// Exact captured text.
    pub content: String,
    /// Host event time.
    pub event_at_ms: Option<i64>,
    /// Engine receipt time.
    pub ingested_at_ms: i64,
    /// Optional provider embedding.
    pub embedding: Option<Vec<f32>>,
    /// Tags supplied by the adapter.
    pub tags: Vec<String>,
    /// Visibility scope.
    pub scope: Scope,
    /// Governance role.
    pub content_role: ContentRole,
    /// Retention purpose.
    pub purpose: MemoryPurpose,
}

impl CaptureEvent {
    /// Normalizes an integration event into the canonical ingestion contract.
    pub fn into_ingest_request(self) -> IngestEventRequest {
        IngestEventRequest {
            source_namespace: SourceNamespace::new(self.adapter.namespace())
                .expect("static adapter namespace"),
            source_event_id: self.source_event_id,
            turn_id: self.turn_id,
            source_kind: self.source_kind,
            source_uri: self.source_uri,
            actor: self.actor,
            identity: self.identity,
            content: self.content,
            event_at_ms: self.event_at_ms,
            ingested_at_ms: self.ingested_at_ms,
            embedding: self.embedding,
            embedding_space: None,
            tags: self.tags,
            scope: self.scope,
            importance: None,
            content_role: self.content_role,
            purpose: self.purpose,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_have_distinct_stable_namespaces() {
        let namespaces = [
            CaptureAdapter::OpenCodeCodex.namespace(),
            CaptureAdapter::ClaudeCode.namespace(),
            CaptureAdapter::Cursor.namespace(),
            CaptureAdapter::Mcp.namespace(),
            CaptureAdapter::Webhook.namespace(),
        ];
        for (index, namespace) in namespaces.iter().enumerate() {
            assert!(!namespace.is_empty());
            assert!(!namespaces[..index].contains(namespace));
        }
    }
}
