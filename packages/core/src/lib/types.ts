// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Library types — the ADN contract.
 *
 * These are the typed shapes that consumers (the web UI, integrators, internal
 * MCP wrappers) import. They are deliberately decoupled from the MCP
 * transport envelope (no `content: [{type:'text', text:...}]` here).
 *
 * For every tool in packages/core/src/mcp/*-tools.ts there is (or will be)
 * a corresponding `Input` and `Output` type in this file plus a core
 * function in a sibling lib/*.ts. The MCP handler in *-tools.ts becomes
 * a thin transport adapter over the core function.
 */

import type { McpToolContext } from '../mcp/types.js';

/**
 * Caller context for any library function. The MCP dispatcher fills this
 * from JSON-RPC metadata. the web UI fills it from its own auth/session layer.
 * The library code only reads — it never authenticates or scopes by itself.
 */
export type ToolCtx = McpToolContext;

/** Re-export so consumers can `import type { ToolCtx } from '@celiums/memory'`. */
export type { McpToolContext } from '../mcp/types.js';

/** Common: a recalled memory in the canonical library shape. */
export interface RecalledMemory {
  /** The stored content. */
  content: string;
  /** Memory taxonomy: 'semantic' | 'procedural' | 'episodic'. */
  type: string;
  /** 0..1 importance (rounded to 2 decimals). */
  importance: number;
  /** Hybrid retrieval final score (rounded to 2 decimals). */
  score: number;
  /** Free-form tags attached on save. */
  tags: string[];
}

/** Limbic state snapshot — present on calls that update mood (recall, remember). */
export interface MoodSnapshot {
  pleasure: number;
  arousal: number;
  dominance: number;
}

/** Thrown when the caller is not authorised for the requested operation.
 *  Library callers should catch this distinctly from generic errors so they
 *  can return HTTP 403 / refuse without leaking internal state. */
export class LibraryAccessDenied extends Error {
  readonly code = 'LIBRARY_ACCESS_DENIED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LibraryAccessDenied';
  }
}

/** Thrown when input fails schema/business validation. */
export class LibraryInvalidInput extends Error {
  readonly code = 'LIBRARY_INVALID_INPUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LibraryInvalidInput';
  }
}
