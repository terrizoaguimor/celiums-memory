import { createMemoryEngine } from '@celiums-memory/core';
import { MemoryConfig, MemoryEngine, RecallResponse, ConsolidationResult } from '@celiums-memory/types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP adapter options.
 */
export interface CeliumsMemoryMcpOptions {
  config?: MemoryConfig;
  defaultUserId?: string;
  serverName?: string;
  serverVersion?: string;
}

/**
 * Builds a config object from environment variables.
 */
function configFromEnv(): MemoryConfig {
  return {
    databaseUrl: process.env.DATABASE_URL,
    qdrantUrl: process.env.QDRANT_URL,
    valkeyUrl: process.env.VALKEY_URL,
  } as MemoryConfig;
}

/**
 * Resolves the active user ID from tool input or environment.
 */
function resolveUserId(userId?: string): string {
  const resolved = userId ?? process.env.CELIUMS_MEMORY_USER_ID ?? 'default';
  if (!resolved.trim()) {
    throw new Error('A valid userId is required');
  }
  return resolved;
}

/**
 * Safely formats arbitrary values into MCP text output.
 */
function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Creates and configures the MCP server for Celiums Memory.
 */
export function createCeliumsMemoryMcpServer(
  options: CeliumsMemoryMcpOptions = {},
) {
  const engine: MemoryEngine = createMemoryEngine(options.config ?? configFromEnv());

  const server = new McpServer({
    name: options.serverName ?? 'celiums-memory',
    version: options.serverVersion ?? '1.0.0',
  });

  server.tool(
    'remember',
    {
      userId: z.string().optional().describe('The logical user/session owner'),
      content: z.string().min(1).describe('Fact, decision, preference, or important memory to store'),
      source: z.string().optional().describe('Source of the memory, e.g. claude-code, cursor, vscode'),
      tags: z.array(z.string()).optional().describe('Optional tags for filtering and organization'),
    },
    async ({ userId, content, source, tags }) => {
      const result = await (engine as any).storeMemory({
        userId: resolveUserId(userId ?? options.defaultUserId),
        content,
        source: source ?? 'mcp',
        tags: tags ?? [],
      });

      return {
        content: [
          {
            type: 'text',
            text: asText({
              success: true,
              operation: 'remember',
              result,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'recall',
    {
      userId: z.string().optional().describe('The logical user/session owner'),
      query: z.string().min(1).describe('Semantic search query'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return'),
      minImportance: z.number().min(0).max(1).optional().describe('Minimum importance threshold'),
    },
    async ({ userId, query, limit, minImportance }) => {
      const result: RecallResponse = await (engine as any).recall({
        userId: resolveUserId(userId ?? options.defaultUserId),
        query,
        limit: limit ?? 10,
        minImportance: minImportance ?? 0,
      });

      return {
        content: [
          {
            type: 'text',
            text: asText({
              success: true,
              operation: 'recall',
              result,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'forget',
    {
      userId: z.string().optional().describe('The logical user/session owner'),
      memoryId: z.string().optional().describe('Delete a specific memory by ID'),
      all: z.boolean().optional().describe('Delete all memories for the user'),
    },
    async ({ userId, memoryId, all }) => {
      const resolvedUserId = resolveUserId(userId ?? options.defaultUserId);

      if (!memoryId && !all) {
        throw new Error('Provide memoryId or set all=true');
      }

      const result = all
        ? await (engine as any).deleteAllMemories({ userId: resolvedUserId })
        : await (engine as any).deleteMemory({ userId: resolvedUserId, memoryId });

      return {
        content: [
          {
            type: 'text',
            text: asText({
              success: true,
              operation: 'forget',
              result,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'context',
    {
      userId: z.string().optional().describe('The logical user/session owner'),
      currentMessage: z.string().min(1).describe('The current prompt/message requiring memory context'),
      maxTokens: z.number().int().min(128).max(32000).optional().describe('Maximum token budget'),
    },
    async ({ userId, currentMessage, maxTokens }) => {
      const result = await (engine as any).getContext({
        userId: resolveUserId(userId ?? options.defaultUserId),
        currentMessage,
        maxTokens: maxTokens ?? 2048,
      });

      return {
        content: [
          {
            type: 'text',
            text: asText({
              success: true,
              operation: 'context',
              result,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'consolidate',
    {
      userId: z.string().optional().describe('The logical user/session owner'),
      conversation: z.string().min(1).describe('Conversation transcript or session summary to consolidate'),
    },
    async ({ userId, conversation }) => {
      const result: ConsolidationResult = await (engine as any).consolidate({
        userId: resolveUserId(userId ?? options.defaultUserId),
        conversation,
      });

      return {
        content: [
          {
            type: 'text',
            text: asText({
              success: true,
              operation: 'consolidate',
              result,
            }),
          },
        ],
      };
    },
  );

  return {
    server,
    engine,
    /**
     * Connects the MCP server over stdio transport.
     */
    async startStdio(): Promise<void> {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}

/**
 * CLI/main entry for the MCP adapter.
 */
export async function main(): Promise<void> {
  const app = createCeliumsMemoryMcpServer();
  await app.startStdio();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Celiums Memory MCP adapter failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}