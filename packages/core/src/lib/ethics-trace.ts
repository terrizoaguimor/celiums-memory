// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ethicsTrace bridge — kept in its own file to avoid a circular import
 * between lib/opencore.ts (which opencore-tools.ts depends on for its core
 * functions) and opencore-tools.ts (which exports handleEthicsTrace).
 *
 * This file does NOT import any other lib/*; opencore-tools.ts imports
 * lib/opencore.ts for cores, and this file imports the named-export
 * handler from opencore-tools.ts. The cycle is one-way: lib/ethics-trace
 * → mcp/opencore-tools → lib/opencore, never back.
 */

import { bridgeHandlerLazy } from './from-handler.js';

export interface EthicsTraceInput {
  trace_id?: string;
  verbose?: boolean;
  content?: string;
}

export interface EthicsTraceOutput {
  trace_id?: string;
  input_summary?: string;
  layer_a?: unknown;
  layer_b?: unknown;
  layer_c?: unknown;
  final_decision?: string;
  knowledge_matches?: unknown[];
}

// Lazy resolution via dynamic import — ESM-safe even if a circular edge
// shows up later. The dynamic import returns a promise we capture once.
let cached: ((args: unknown, ctx: unknown) => Promise<unknown>) | null = null;
async function resolveHandler() {
  if (cached) return cached;
  const mod = await import('../mcp/opencore-tools.js');
  cached = mod.handleEthicsTrace as any;
  return cached;
}

export const ethicsTrace = bridgeHandlerLazy<EthicsTraceInput, EthicsTraceOutput>(() => {
  // bridgeHandlerLazy expects sync resolution. If we haven't pre-resolved yet
  // throw a marker error so the caller knows to await initEthicsTrace() first.
  if (!cached) {
    // Best-effort sync resolution would require require() which breaks ESM.
    // Trigger the resolution promise (fire-and-forget) so subsequent calls
    // succeed; this call will fail until then. In practice callers should
    // hit initEthicsTrace once at startup.
    void resolveHandler();
    return undefined;
  }
  return cached as any;
});

/** Optional pre-resolve hook — call once at app startup to avoid a missed
 *  first call. MCP server callers don't need this; the web UI / direct callers
 *  that hit ethicsTrace early on may. */
export async function initEthicsTrace(): Promise<void> {
  await resolveHandler();
}
