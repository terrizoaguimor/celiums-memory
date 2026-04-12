/**
 * @celiums/adapter-mcp — Model Context Protocol adapter
 *
 * Exposes the Celiums Knowledge Engine as an MCP server compatible with:
 * - Claude Code / Claude Desktop
 * - Cursor
 * - VS Code (via MCP extension)
 * - Windsurf / Codeium
 * - Cline
 * - Zed
 * - Any MCP-compatible AI tool
 *
 * Supports two transport modes:
 * - stdio: For CLI integration (npx @celiums/mcp)
 * - HTTP: For direct server connections
 *
 * @example
 * ```typescript
 * import { createEngine } from "@celiums/core";
 * import { McpAdapter } from "@celiums/adapter-mcp";
 *
 * const engine = await createEngine(config);
 * const mcp = new McpAdapter(engine);
 * await mcp.start(); // Starts stdio transport
 * ```
 *
 * @package @celiums/adapter-mcp
 * @license Apache-2.0
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CeliumsEngine, ToolName, CeliumsAdapter } from "@celiums/types";

export class McpAdapter implements CeliumsAdapter {
  name = "mcp";
  private engine: CeliumsEngine;
  private server: Server;

  constructor(engine: CeliumsEngine) {
    this.engine = engine;
    this.server = new Server(
      { name: "celiums", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
  }

  /**
   * Initialize the MCP adapter — register all tool handlers.
   */
  async initialize(engine: CeliumsEngine): Promise<void> {
    this.engine = engine;
    this.registerHandlers();
  }

  /**
   * Start the MCP server with stdio transport.
   * This is the default mode for CLI usage (npx @celiums/mcp).
   */
  async start(): Promise<void> {
    this.registerHandlers();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  /**
   * Gracefully shut down the MCP server.
   */
  async stop(): Promise<void> {
    await this.server.close();
  }

  /**
   * Register MCP request handlers for tool listing and execution.
   */
  private registerHandlers(): void {
    // Handler: List all available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.engine.getTools();
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as {
            type: "object";
            properties?: Record<string, unknown>;
            required?: string[];
          },
        })),
      };
    });

    // Handler: Execute a tool by name
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolName = name as ToolName;
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      const result = await this.engine.executeTool(toolName, toolArgs);

      return {
        content: result.content.map((c) => ({
          type: "text" as const,
          text: c.text ?? "",
        })),
        isError: result.isError,
      };
    });
  }
}

/**
 * Create and start an MCP adapter connected to a Celiums engine.
 * Convenience function for quick setup.
 *
 * @example
 * ```typescript
 * import { startMcp } from "@celiums/adapter-mcp";
 * import { createEngine } from "@celiums/core";
 *
 * const engine = await createEngine(config);
 * await startMcp(engine);
 * ```
 */
export async function startMcp(engine: CeliumsEngine): Promise<McpAdapter> {
  const adapter = new McpAdapter(engine);
  await adapter.start();
  return adapter;
}
