// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bridge helper — wraps an existing MCP handler in a typed library function.
 *
 * Used for tools whose logic is deep and complex enough that extracting the
 * entire body into a separate file is more disruption than value (LLM calls,
 * embeddings, multi-step pipelines). For those, the MCP handler remains the
 * source of truth; this helper hides the McpToolResult envelope from
 * library consumers.
 *
 * Trade-off: there is a small JSON.stringify → JSON.parse round-trip
 * because handlers return `ok(asText(obj))` or `okJson(obj)`. This is
 * in-process — no network — so the cost is microseconds. When a tool's
 * usage profile makes that cost matter, refactor its handler to a real
 * library function (see lib/recall.ts, lib/journal-write.ts as templates).
 *
 * Contract guarantees:
 *   - Library callers see typed Promise<T>.
 *   - Errors return values become thrown LibraryInvalidInput.
 *   - This module never imports from /mcp/*-tools.ts itself; the handler
 *     is passed in by the lib/<tool>.ts file. Keeps the dependency tree
 *     acyclic.
 */

import type { McpToolHandler, McpToolResult } from '../mcp/types.js';
import type { ToolCtx } from './types.js';
import { LibraryInvalidInput } from './types.js';

/** Extract the text payload from a tool result. Returns the parsed JSON
 *  when the text is a JSON object, the raw string otherwise. */
function unwrapResult<T>(result: McpToolResult): T {
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) {
    throw new LibraryInvalidInput(text || 'tool returned isError without text');
  }
  // Best-effort JSON parse. Tools using ok(asText(obj)) or okJson(obj) emit
  // JSON; tools using ok(plainText) keep the string.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return text as unknown as T;
    }
  }
  return text as unknown as T;
}

/**
 * Build a library function from an MCP handler. The returned function:
 *   - Accepts the typed input I directly
 *   - Returns the typed output O (parsed from the handler's text payload)
 *   - Throws LibraryInvalidInput when the handler returned isError
 *
 * Note: I and O are TypeScript-only declarations — they don't validate at
 * runtime. The MCP dispatcher already validates inputs via ajv (P0-C).
 */
export function bridgeHandler<I extends object, O>(
  handler: McpToolHandler,
): (input: I, ctx: ToolCtx) => Promise<O> {
  return async (input, ctx) => {
    const result = await handler(input as any, ctx);
    return unwrapResult<O>(result);
  };
}

/** Same as bridgeHandler but the wrapped function returns the raw string —
 *  useful for tools whose output is meant to be human-readable text and not
 *  a structured object. */
export function bridgeHandlerText<I extends object>(
  handler: McpToolHandler,
): (input: I, ctx: ToolCtx) => Promise<string> {
  return async (input, ctx) => {
    const result = await handler(input as any, ctx);
    if (result.isError) {
      throw new LibraryInvalidInput(result.content?.[0]?.text ?? 'tool error');
    }
    return result.content?.[0]?.text ?? '';
  };
}

/**
 * Lazy variant — resolves the handler only on first invocation.
 *
 * Use when the tool registry containing the handler has a circular import
 * with the lib/* file that needs to expose its facades. The resolver is
 * called once on the first library call; subsequent calls reuse the
 * captured handler.
 */
export function bridgeHandlerLazy<I extends object, O>(
  resolve: () => McpToolHandler | undefined,
): (input: I, ctx: ToolCtx) => Promise<O> {
  let resolved: McpToolHandler | null = null;
  return async (input, ctx) => {
    if (!resolved) {
      const h = resolve();
      if (!h) {
        throw new LibraryInvalidInput('handler not found in registry — registry not initialised?');
      }
      resolved = h;
    }
    const result = await resolved(input as any, ctx);
    return unwrapResult<O>(result);
  };
}
