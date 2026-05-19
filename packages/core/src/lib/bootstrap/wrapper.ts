// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bootstrap wrapper — the function the MCP dispatcher invokes after
 * a tool handler completes. Decides whether to wrap the response
 * with a session_context block.
 *
 * Pure function over (toolResult, sessionContext, store, composer).
 * Errors are SWALLOWED — the wrapper MUST NOT prevent the tool's
 * own response from being returned. Bootstrap is best-effort.
 */

import type {
  BootstrapStore, BootstrapDecision, WrappedResponse,
} from './types.js';
import {
  composeBootstrap, renderBootstrap, newRecord,
  type TurnContextFn,
} from './composer.js';

export interface BootstrapWrapperOptions {
  store: BootstrapStore;
  turnContext: TurnContextFn;
  /** Per-call session context. */
  sessionId: string;
  agentId: string;
  userId: string;
  tenantId: string | null;
  /** Optional overrides from the caller. */
  budgetTokens?: number;
  channels?: ReadonlyArray<string>;
  /** Telemetry hook — fires once per wrap decision. Fire-and-forget. */
  onDecision?: (info: {
    sessionId: string;
    decision: BootstrapDecision;
    tokens?: number;
    composedInMs?: number;
    channelsPopulated?: string[];
    toolName?: string;
  }) => void;
}

export interface ShouldBootstrapInput {
  /** From env CELIUMS_BOOTSTRAP. */
  envFlag?: string;
  /** From request header X-Celiums-Bootstrap. */
  headerFlag?: string;
  /** From tool registry — true if the tool is bootstrap-exempt. */
  toolExempt?: boolean;
  /** When false, never bootstrap (e.g., anonymous session). */
  hasSession?: boolean;
}

/**
 * Decide whether to compose + wrap. Caller has already retrieved the
 * tool result. This function only decides; the wrap itself happens in
 * `wrapToolResponse`.
 */
export async function shouldBootstrap(
  input: ShouldBootstrapInput,
  store: BootstrapStore,
  sessionId: string,
): Promise<BootstrapDecision> {
  if (input.envFlag === 'disabled') {
    return { shouldBootstrap: false, reason: 'opt-out-env' };
  }
  if (input.headerFlag === 'disabled') {
    return { shouldBootstrap: false, reason: 'opt-out-header' };
  }
  if (input.toolExempt) {
    return { shouldBootstrap: false, reason: 'opt-out-tool' };
  }
  if (input.hasSession === false) {
    return { shouldBootstrap: false, reason: 'no-session' };
  }

  const existing = await store.get(sessionId).catch((): null => null);
  if (existing) {
    return { shouldBootstrap: false, reason: 'cache-hit' };
  }
  return { shouldBootstrap: true, reason: 'first-call' };
}

/**
 * Wrap a tool response. Returns `{ tool_result, session_context? }`.
 * When bootstrap is skipped (cache hit, opt-out, no session), the
 * wrapper passes the original result through unchanged in a
 * `{ tool_result }` envelope (the dispatcher should unwrap when
 * emitting the MCP response — that's an envelope detail).
 *
 * Wrapping FAILURE: any error during composition is logged via
 * onDecision and the response is returned unwrapped.
 */
export async function wrapToolResponse<T>(
  toolResult: T,
  decision: BootstrapDecision,
  opts: BootstrapWrapperOptions,
  toolName?: string,
): Promise<WrappedResponse<T>> {
  // Skip path: return as-is (still in the envelope shape).
  if (!decision.shouldBootstrap) {
    opts.onDecision?.({
      sessionId: opts.sessionId,
      decision,
      ...(toolName ? { toolName } : {}),
    });
    return { tool_result: toolResult };
  }

  // Compose + wrap.
  const composeOpts: import('./types.js').BootstrapComposerInput = {
    agentId: opts.agentId,
    userId: opts.userId,
    tenantId: opts.tenantId,
  };
  if (opts.budgetTokens !== undefined) composeOpts.budgetTokens = opts.budgetTokens;
  if (opts.channels !== undefined) composeOpts.channels = opts.channels;
  const content = await composeBootstrap(composeOpts, opts.turnContext);

  if (!content) {
    // Composer failed → unwrap, log.
    opts.onDecision?.({
      sessionId: opts.sessionId,
      decision: { shouldBootstrap: false, reason: 'composer-failed' },
      ...(toolName ? { toolName } : {}),
    });
    return { tool_result: toolResult };
  }

  // Mark bootstrapped — fire-and-forget. We do not block the response
  // on the store write. If it fails, the next call will re-bootstrap.
  void opts.store.set(newRecord({
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    userId: opts.userId,
    tenantId: opts.tenantId,
  })).catch(() => { /* logged by store onError */ });

  const channelsPopulated = content.channels.map((c) => c.name);

  opts.onDecision?.({
    sessionId: opts.sessionId,
    decision,
    tokens: content.totalTokens,
    composedInMs: content.composedInMs,
    channelsPopulated,
    ...(toolName ? { toolName } : {}),
  });

  return {
    tool_result: toolResult,
    session_context: {
      auto_loaded: true,
      session_id: opts.sessionId,
      content: renderBootstrap(content),
      metadata: {
        channels_populated: channelsPopulated,
        total_tokens: content.totalTokens,
        composed_in_ms: content.composedInMs,
      },
    },
  };
}

/** Serialise a WrappedResponse to the XML-tagged form MCP clients
 *  expect (per ADR-025 §"Response shape"). The tagged form is what
 *  the model sees in its tool result. */
export function serialiseWrapped<T>(
  wrapped: WrappedResponse<T>,
  toolResultRender: (r: T) => string,
): string {
  const toolBlock = `<tool_result>\n${toolResultRender(wrapped.tool_result)}\n</tool_result>`;
  if (!wrapped.session_context) return toolBlock;
  const sc = wrapped.session_context;
  const sessionBlock =
    `<session_context auto_loaded="true" session_id="${sc.session_id}">\n` +
    sc.content +
    `\n</session_context>`;
  return `${sessionBlock}\n${toolBlock}`;
}
