/**
 * @celiums/memory MCP — types
 *
 * Minimal MCP (Model Context Protocol) JSON-RPC types for our handler.
 * We don't depend on @modelcontextprotocol/sdk because we serve raw JSON
 * over HTTP — the SDK is for stdio/long-running connections.
 */

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: any;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * MCP standard error codes (subset).
 */
export const McpErrorCode = {
  PARSE_ERROR:       -32700,
  INVALID_REQUEST:   -32600,
  METHOD_NOT_FOUND:  -32601,
  INVALID_PARAMS:    -32602,
  INTERNAL_ERROR:    -32603,
  // App-specific (any negative below -32000)
  TOOL_NOT_FOUND:    -32001,
  TOOL_DISABLED:     -32002,
  AUTH_REQUIRED:     -32003,
} as const;

/**
 * MCP tool definition shape (matches Anthropic MCP spec).
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP tool call result — always wrapped in `content` array of TextContent
 * (or other content types). For our tools we only emit text.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Capabilities discovered at runtime from env vars.
 * Determines which tool groups are exposed via tools/list.
 */
export interface McpCapabilities {
  /** Always true — OpenCore tools (10) */
  opencore: true;
  /** True if CELIUMS_FLEET_API_KEY is set */
  fleet: boolean;
  /** True if CELIUMS_ATLAS_API_KEY is set */
  atlas: boolean;
}

/**
 * Detect capabilities from process env. Pure function, called per request
 * so users can change env without restarting (unlikely but safe).
 */
export function detectCapabilities(env: NodeJS.ProcessEnv = process.env): McpCapabilities {
  return {
    opencore: true,
    fleet:    !!(env.CELIUMS_FLEET_API_KEY && env.CELIUMS_FLEET_API_KEY.length > 5),
    atlas:    !!(env.CELIUMS_ATLAS_API_KEY && env.CELIUMS_ATLAS_API_KEY.length > 5),
  };
}

/**
 * Per-request context passed to every tool handler.
 */
export interface McpToolContext {
  userId: string;
  capabilities: McpCapabilities;
  /** The store the handler can talk to (knowledge module store). */
  moduleStore?: unknown;
  /** The memory engine — for remember/recall delegation. */
  memoryEngine?: unknown;
  /** PG pool for the celiums_memory DB (rarely needed since memoryEngine wraps it). */
  pool?: unknown;
}

/**
 * A tool handler — receives args + context, returns a result (or throws).
 */
export type McpToolHandler = (
  args: Record<string, any>,
  ctx: McpToolContext,
) => Promise<McpToolResult>;

/**
 * A registered tool: definition + handler + group label for capability gating.
 */
export interface RegisteredTool {
  group: 'opencore' | 'fleet' | 'atlas';
  definition: McpToolDefinition;
  handler: McpToolHandler;
}
