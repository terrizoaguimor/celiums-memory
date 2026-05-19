// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums/memory MCP — JSON-RPC dispatcher
 *
 * Handles the 3 MCP methods we care about:
 *   - initialize         → handshake + capabilities + serverInfo
 *   - tools/list         → returns capability-gated tool list
 *   - tools/call         → invokes a tool by name with args
 *
 * Capability gating:
 *   detectCapabilities() inspects env vars at request time. tools/list
 *   filters the registry to only include tools whose `group` is enabled.
 *   tools/call refuses to invoke a disabled tool with TOOL_DISABLED.
 *
 * The dispatcher is HTTP-agnostic — it takes a parsed JSON-RPC request
 * and returns a JSON-RPC response. The HTTP wrapper lives in quickstart.ts.
 */

import {
  detectCapabilities,
  McpErrorCode,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpToolContext,
  type McpToolResult,
  type RegisteredTool,
} from './types.js';
import { OPENCORE_TOOLS } from './opencore-tools.js';
import { SECURE_TOOLS } from './secure-tools.js';
import { JOURNAL_TOOLS } from './journal-tools.js';
import { WRITE_TOOLS } from './write-tools.js';
import { RESEARCH_TOOLS } from './research-tools.js';
import { ATLAS_TOOLS } from './atlas-tools.js';
import { PROACTIVE_TOOLS } from './proactive-tools.js';
import { ETHICS_TOOLS } from './ethics-tools.js';
import { WEB_SEARCH_TOOLS } from './web-search-tools.js';
// universal_knowledge RETIRED 2026-05-16 — raw 10M-doc OpenSearch dump is
// not the Celiums model (data already purged; curated `skills` corpus +
// the Knowledge Federation Layer replace it). See #166.
import { validateToolInput } from './schema-validator.js';
import { isOwner, isAdminOrOwner, roleOf } from '../lib/roles.js';
import { writeAuditEvent } from './security-audit.js';
import {
  shouldBootstrap, wrapToolResponse, serialiseWrapped,
  deriveSessionId,
  type BootstrapStore, type TurnContextFn,
} from '../lib/bootstrap/index.js';
import type { BootstrapDecision } from '../lib/bootstrap/index.js';

/**
 * Build the full registry. OpenCore (always on, no LLM required) +
 * AI-backed tools (journal, write, research) that need an OpenAI-compatible
 * LLM configured via CELIUMS_LLM_API_KEY. Research additionally needs
 * a corpus-search backend (CELIUMS_SEARCH_URL) for the synthesize/search
 * tools — project/findings/gaps tracking work without it.
 */
export function buildRegistry(): RegisteredTool[] {
  return [
    ...OPENCORE_TOOLS,
    ...SECURE_TOOLS,
    ...JOURNAL_TOOLS,
    ...WRITE_TOOLS,
    ...RESEARCH_TOOLS,
    ...ATLAS_TOOLS,
    ...PROACTIVE_TOOLS,
    ...ETHICS_TOOLS,
    ...WEB_SEARCH_TOOLS,
  ];
}

/**
 * Filter the registry by capabilities currently active in env.
 * OpenCore tools are always present. AI-backed tools (`group: 'ai'`) only
 * appear if `CELIUMS_LLM_API_KEY` is configured (any OpenAI-compatible
 * endpoint).
 */
export function listAvailableTools(env: NodeJS.ProcessEnv = process.env): RegisteredTool[] {
  const caps = detectCapabilities(env);
  const all = buildRegistry();
  return all.filter((t) => {
    if (t.group === 'opencore') return caps.opencore;
    if (t.group === 'fleet')    return caps.fleet;
    if (t.group === 'atlas')    return caps.atlas;
    if (t.group === 'ai')       return caps.ai;
    return false;
  });
}

/**
 * Find a tool by name in the FULL registry (regardless of capability).
 * Used by tools/call to distinguish "not found" from "disabled".
 */
function findTool(name: string): RegisteredTool | undefined {
  return buildRegistry().find((t) => t.definition.name === name);
}

/**
 * Pretty error → JSON-RPC error converter.
 */
function rpcError(
  id: McpJsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): McpJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}

function rpcOk(id: McpJsonRpcRequest['id'], result: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Server info reported in the `initialize` handshake.
 */
const SERVER_INFO = {
  name: '@celiums/memory',
  version: '0.5.0',
};

const PROTOCOL_VERSION = '2024-11-05';

/**
 * ADR-025 auto-bootstrap configuration. Pass to `dispatchMcp` to
 * enable session_context wrapping of the first tool call per session.
 * Omit to disable (backwards-compatible — no behavioural change).
 */
export interface DispatchBootstrapConfig {
  store: BootstrapStore;
  turnContext: TurnContextFn;
  /** Per-call request header value (`X-Celiums-Bootstrap`). */
  headerFlag?: string | undefined;
  /** Tool names that skip wrapping (e.g. liveness/version probes). */
  exemptTools?: ReadonlySet<string> | ReadonlyArray<string>;
  /** Composer overrides. */
  budgetTokens?: number;
  channels?: ReadonlyArray<string>;
  /** Telemetry hook — pass `makeBootstrapObserver(...)` output here. */
  onDecision?: (info: {
    sessionId: string;
    decision: BootstrapDecision;
    tokens?: number;
    composedInMs?: number;
    channelsPopulated?: string[];
    toolName?: string;
    agentId?: string;
  }) => void;
}

/** Optional 4th arg to dispatchMcp. */
export interface DispatchMcpOptions {
  bootstrap?: DispatchBootstrapConfig;
}

/**
 * Top-level MCP dispatch. Returns a JSON-RPC response object.
 *
 * Optional 4th arg: `{ bootstrap }` to enable ADR-025 auto-bootstrap.
 * Existing callers passing 3 args are unaffected.
 */
export async function dispatchMcp(
  rpc: McpJsonRpcRequest,
  ctx: McpToolContext,
  env: NodeJS.ProcessEnv = process.env,
  opts: DispatchMcpOptions = {},
): Promise<McpJsonRpcResponse> {
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return rpcError(rpc.id, McpErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC envelope');
  }

  // ─── initialize ───────────────────────────────────────────
  if (rpc.method === 'initialize') {
    return rpcOk(rpc.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: SERVER_INFO,
    });
  }

  // ─── ping (liveness check from mcp-proxy) ─────────────────
  if (rpc.method === 'ping') {
    return rpcOk(rpc.id, {});
  }

  // ─── notifications/initialized (no-op, no response needed) ─
  if (rpc.method === 'notifications/initialized') {
    // For HTTP we still return something — but the client should ignore it.
    return rpcOk(rpc.id, {});
  }

  // ─── tools/list ───────────────────────────────────────────
  // CHANGED v1.2.4: list ALL tools regardless of capability. Capabilities are
  // gated at *call* time, not at list time. This way tool catalogs (Glama,
  // Smithery, mcpo, etc.) can index the full surface area of @celiums/memory
  // without needing to provision an LLM key first. Calling an AI-backed tool
  // without `CELIUMS_LLM_API_KEY` set returns a clear TOOL_DISABLED error.
  if (rpc.method === 'tools/list') {
    const tools = buildRegistry().map((t) => t.definition);
    return rpcOk(rpc.id, { tools });
  }

  // ─── tools/call ───────────────────────────────────────────
  if (rpc.method === 'tools/call') {
    const params = rpc.params ?? {};
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== 'string') {
      return rpcError(rpc.id, McpErrorCode.INVALID_PARAMS, 'tools/call requires params.name');
    }
    const tool = findTool(name);
    if (!tool) {
      return rpcError(rpc.id, McpErrorCode.TOOL_NOT_FOUND, `Unknown tool: ${name}`);
    }
    // Privilege ladder (2026-05-12): owner/admin bypass — founders and
    // operational admins must have unrestricted access. Capability gates
    // and schema validation only apply to role=user. Every bypass is
    // recorded so the trail is explicit.
    const ownerCtx = isOwner(ctx);
    const adminCtx = isAdminOrOwner(ctx);

    // Capability gate (call-time) — bypassed for owner/admin
    const caps = detectCapabilities(env);
    if (!adminCtx) {
      if (tool.group === 'fleet' && !caps.fleet) {
        return rpcError(
          rpc.id,
          McpErrorCode.TOOL_DISABLED,
          `Tool "${name}" requires CELIUMS_FLEET_API_KEY to be set`,
        );
      }
      if (tool.group === 'atlas' && !caps.atlas) {
        return rpcError(
          rpc.id,
          McpErrorCode.TOOL_DISABLED,
          `Tool "${name}" requires CELIUMS_ATLAS_API_KEY to be set`,
        );
      }
      if (tool.group === 'ai' && !caps.ai) {
        return rpcError(
          rpc.id,
          McpErrorCode.TOOL_DISABLED,
          `Tool "${name}" requires CELIUMS_LLM_API_KEY (any OpenAI-compatible endpoint). See https://github.com/terrizoaguimor/celiums-memory#configure-your-llm-byok`,
        );
      }
    } else if (tool.group !== 'opencore') {
      // Owner/admin used a capability-gated tool even though the env key
      // for that capability is unset — audit it so we know who's running
      // what. Fire-and-forget; never blocks the call.
      void writeAuditEvent(ctx, {
        event_kind: 'tool.capability_bypass',
        user_id: ctx.userId,
        agent_id: ctx.agentId ?? null,
        decision: 'allow',
        reason: `${roleOf(ctx)} bypass: ${tool.group} capability not set in env`,
        details: { tool: name, group: tool.group, missing_env: !caps[tool.group as keyof typeof caps] },
      });
    }

    // SECURITY (P0-C 2026-05-12): strict JSON-Schema validation of args
    // BEFORE the handler runs. Schema files at /schemas/v1/mcp-inputs/ are
    // authoritative. Inline tool inputSchemas are validated leniently
    // (no additionalProperties forcing — see schema-validator.ts).
    //
    // OWNER BYPASS: owners and admins skip validation entirely. This is
    // the "founder root" path — if Mario passes a non-standard arg
    // (debugging, exploring a new tool field, calling from a custom
    // client), the call goes through. Every bypass is audit-logged.
    if (!ownerCtx) {
      const validation = validateToolInput(name, args, {
        inlineInputSchema: tool.definition.inputSchema,
      });
      if (validation.ok !== true) {
        return rpcError(rpc.id, McpErrorCode.INVALID_PARAMS, validation.error);
      }
    } else {
      // Validate anyway to capture WHAT would have been rejected — but
      // proceed regardless. Useful for debugging schema mismatches.
      const validation = validateToolInput(name, args, {
        inlineInputSchema: tool.definition.inputSchema,
      });
      if (validation.ok !== true) {
        void writeAuditEvent(ctx, {
          event_kind: 'tool.schema_bypass',
          user_id: ctx.userId,
          agent_id: ctx.agentId ?? null,
          decision: 'allow',
          reason: 'owner bypass: schema validation failed but allowed',
          details: { tool: name, error: validation.error.slice(0, 300) },
        });
      }
    }

    // OSS refactor #174: entitlement/tool-tier gate removed. Celiums Memory
    // is Apache-2.0 OSS — no plan tiers, no subscription gating. Every tool
    // dispatches directly (the capability/role checks above stay; those are
    // engine security, not SaaS plan governance).

    // Inject capabilities into context
    const fullCtx: McpToolContext = { ...ctx, capabilities: caps };
    let result: McpToolResult;
    try {
      result = await tool.handler(args, fullCtx);
    } catch (err: any) {
      const code = typeof err?.code === 'number' ? err.code : McpErrorCode.INTERNAL_ERROR;
      return rpcError(rpc.id, code, err?.message ?? 'tool execution failed');
    }

    // ADR-025 auto-bootstrap: when configured, wrap the first tool
    // response per session with a <session_context> block. Errors here
    // are swallowed — bootstrap MUST NOT prevent the tool's response.
    if (opts.bootstrap) {
      try {
        result = await maybeBootstrapWrap(result, name, fullCtx, env, opts.bootstrap);
      } catch (e) {
        console.error('[celiums-core] bootstrap wrap failed:', (e as Error).message);
      }
    }

    return rpcOk(rpc.id, result);
  }

  return rpcError(rpc.id, McpErrorCode.METHOD_NOT_FOUND, `Unknown method: ${rpc.method}`);
}

/**
 * ADR-025 — post-handler wrap helper. Returns the original result on
 * skip / failure, or a new result with `<session_context>` prepended
 * to the first content item.
 *
 * Session id derivation: ctx.sessionId if set; otherwise hash of
 * (userId, agentId, request open timestamp from ctx.requestId if it
 * encodes one, else now()).
 */
async function maybeBootstrapWrap(
  result: McpToolResult,
  toolName: string,
  ctx: McpToolContext,
  env: NodeJS.ProcessEnv,
  cfg: DispatchBootstrapConfig,
): Promise<McpToolResult> {
  const userId = String(ctx.userId || '').trim();
  const agentId = String(ctx.agentId || '').trim();
  const hasSession = Boolean(userId);

  // Compute / accept a sessionId. ctx.sessionId is honoured first.
  // Otherwise we derive a STABLE id from (user, agent) so the
  // bootstrap cache hits across calls in the same session. Using
  // Date.now() here would give every tool-call its own session id
  // and bootstrap would re-wrap every response. Callers that need
  // to differentiate concurrent sessions for the same (user, agent)
  // pair must pass ctx.sessionId explicitly.
  const explicitSid = ctx.sessionId || (env['CELIUMS_SESSION_ID'] as string | undefined);
  const sessionId = hasSession
    ? deriveSessionId({
        userId,
        agentId: agentId || 'unknown',
        connectionOpenedAt: 0,
        ...(explicitSid ? { explicitSessionId: explicitSid } : {}),
      })
    : '';

  const exemptSet = cfg.exemptTools instanceof Set
    ? cfg.exemptTools
    : new Set(cfg.exemptTools ?? []);

  const decisionInput: import('../lib/bootstrap/index.js').ShouldBootstrapInput = {
    hasSession,
    toolExempt: exemptSet.has(toolName),
  };
  if (env['CELIUMS_BOOTSTRAP']) decisionInput.envFlag = env['CELIUMS_BOOTSTRAP'];
  if (cfg.headerFlag) decisionInput.headerFlag = cfg.headerFlag;

  const decision = await shouldBootstrap(decisionInput, cfg.store, sessionId);

  const wrapperOpts: import('../lib/bootstrap/index.js').BootstrapWrapperOptions = {
    store: cfg.store,
    turnContext: cfg.turnContext,
    sessionId,
    agentId: agentId || 'unknown',
    userId: userId || 'anonymous',
    tenantId: ctx.projectId ?? null,
  };
  if (cfg.budgetTokens !== undefined) wrapperOpts.budgetTokens = cfg.budgetTokens;
  if (cfg.channels !== undefined) wrapperOpts.channels = cfg.channels;
  if (cfg.onDecision) {
    wrapperOpts.onDecision = (info) => cfg.onDecision!({ ...info, agentId: agentId || 'unknown' });
  }

  const wrapped = await wrapToolResponse(result, decision, wrapperOpts, toolName);

  if (!wrapped.session_context) {
    // Pass-through (skip / opt-out / cache hit / composer failure).
    return result;
  }

  // Prepend the session_context block to the FIRST text content item.
  // Other content items (binary, multiple text parts) pass through.
  const sc = wrapped.session_context;
  const block =
    `<session_context auto_loaded="true" session_id="${sc.session_id}">\n` +
    sc.content +
    `\n</session_context>\n`;

  const out: McpToolResult = {
    content: result.content.map((item, i) =>
      i === 0 && item.type === 'text'
        ? { ...item, text: block + item.text }
        : item,
    ),
  };
  if (result.isError !== undefined) out.isError = result.isError;
  // If no text content existed (defensive — most tools always have one),
  // synthesise a text item with the bootstrap block.
  if (out.content.length === 0) {
    out.content = [{ type: 'text', text: block }];
  }
  return out;
}

