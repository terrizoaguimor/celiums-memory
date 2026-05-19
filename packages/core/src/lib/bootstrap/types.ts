// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Auto-bootstrap types — implements ADR-025.
 *
 * The bootstrap wraps the FIRST MCP tool response of a session with
 * a <session_context auto_loaded="true"> block so clients without
 * hook infrastructure (Claude web, ChatGPT, Cursor, Antigravity) get
 * deterministic context loading.
 */

/** Composed bootstrap content — ≤2000 tokens by construction. */
export interface BootstrapContent {
  /** Channels populated in this bootstrap, in priority order. */
  channels: Array<{
    name: string;
    /** Pre-rendered text. */
    text: string;
    /** Rough token estimate (chars / 4). Caller may overwrite with real tokeniser. */
    tokens: number;
  }>;
  /** Sum of channel tokens. */
  totalTokens: number;
  /** Time the composition cost (ms). Telemetry. */
  composedInMs: number;
}

/** Per-session bootstrap state stored in the cache. */
export interface BootstrapRecord {
  sessionId: string;
  agentId: string;
  userId: string;
  tenantId: string | null;
  bootstrappedAt: number; // unix ms
  expiresAt: number;      // unix ms
}

/** TTL store contract — MemoryBootstrapStore + ValkeyBootstrapStore. */
export interface BootstrapStore {
  /** Returns the record when present + not expired. */
  get(sessionId: string, nowMs?: number): Promise<BootstrapRecord | null>;
  /** Mark bootstrapped. ttlMs overrides the store default. */
  set(record: BootstrapRecord): Promise<void>;
  /** Force re-bootstrap (testing, admin nuke). */
  invalidate(sessionId: string): Promise<void>;
  /** Best-effort liveness — used by `/readyz`. */
  healthy(): Promise<boolean>;
}

/** Inputs to the composer. The composer turns these into a
 *  BootstrapContent by calling turn_context underneath. */
export interface BootstrapComposerInput {
  agentId: string;
  userId: string;
  tenantId: string | null;
  /** Token budget. Default 2000 per ADR-025. */
  budgetTokens?: number;
  /** Channel priority list. Defaults documented in composer.ts. */
  channels?: ReadonlyArray<string>;
}

/** Result of `wrapToolResponse` — caller emits this verbatim. */
export interface WrappedResponse<T> {
  /** Original tool result. */
  tool_result: T;
  /** When the request was bootstrapped this turn. Absent on subsequent
   *  calls in the same session. */
  session_context?: {
    auto_loaded: true;
    session_id: string;
    content: string;
    metadata: {
      channels_populated: string[];
      total_tokens: number;
      composed_in_ms: number;
    };
  };
}

/** Signals from the dispatcher about whether to wrap. */
export interface BootstrapDecision {
  /** Whether to compose + wrap this response. */
  shouldBootstrap: boolean;
  /** Reason — for logs / metrics. */
  reason: 'first-call' | 'cache-hit' | 'opt-out-env' | 'opt-out-header' | 'opt-out-tool' | 'no-session' | 'composer-failed';
}
