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

/**
 * Build the full registry. Right now it's only OpenCore (Wave 1).
 * Wave 2 will append FLEET_TOOLS, Wave 3 will append ATLAS_TOOLS.
 */
export function buildRegistry(): RegisteredTool[] {
  return [
    ...OPENCORE_TOOLS,
    // ...FLEET_TOOLS,   // added in Wave 2
    // ...ATLAS_TOOLS,   // added in Wave 3
  ];
}

/**
 * Filter the registry by capabilities currently active in env.
 * OpenCore tools are always present. Fleet and Atlas tools only appear
 * if their respective API keys are configured.
 */
export function listAvailableTools(env: NodeJS.ProcessEnv = process.env): RegisteredTool[] {
  const caps = detectCapabilities(env);
  const all = buildRegistry();
  return all.filter((t) => {
    if (t.group === 'opencore') return caps.opencore;
    if (t.group === 'fleet')    return caps.fleet;
    if (t.group === 'atlas')    return caps.atlas;
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
 * Top-level MCP dispatch. Returns a JSON-RPC response object.
 */
export async function dispatchMcp(
  rpc: McpJsonRpcRequest,
  ctx: McpToolContext,
  env: NodeJS.ProcessEnv = process.env,
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
  if (rpc.method === 'tools/list') {
    const tools = listAvailableTools(env).map((t) => t.definition);
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
    // Capability gate
    const caps = detectCapabilities(env);
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
    // Inject capabilities into context
    const fullCtx: McpToolContext = { ...ctx, capabilities: caps };
    try {
      const result: McpToolResult = await tool.handler(args, fullCtx);
      return rpcOk(rpc.id, result);
    } catch (err: any) {
      const code = typeof err?.code === 'number' ? err.code : McpErrorCode.INTERNAL_ERROR;
      return rpcError(rpc.id, code, err?.message ?? 'tool execution failed');
    }
  }

  return rpcError(rpc.id, McpErrorCode.METHOD_NOT_FOUND, `Unknown method: ${rpc.method}`);
}
