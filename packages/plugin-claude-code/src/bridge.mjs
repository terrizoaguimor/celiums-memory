#!/usr/bin/env node
/**
 * celiums-memory MCP bridge for Claude Code.
 *
 * Exposes 6 tools via stdio MCP:
 *   - remember          Store a memory with emotional context
 *   - recall            Semantic + emotional search (full details)
 *   - search            Token-efficient compact search (just IDs + summaries)
 *   - timeline          Recent memories chronologically
 *   - emotion           Current AI emotional state
 *   - forget            Delete memories
 *
 * Usage:
 *   node bridge.mjs
 *   CELIUMS_MEMORY_URL=http://localhost:3210 CELIUMS_MEMORY_USER_ID=mario node bridge.mjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import client from './client.mjs';

const server = new McpServer({
  name: 'celiums-memory',
  version: '0.1.0',
});

// ─── remember ──────────────────────────────────────────
server.tool(
  'remember',
  'Store a memory with emotional context. The system automatically extracts PAD (Pleasure/Arousal/Dominance) and importance. Persists across sessions forever.',
  {
    content: z.string().min(1).describe('The memory content to store'),
    tags: z.array(z.string()).optional().describe('Optional tags for organization'),
  },
  async ({ content, tags }) => {
    const result = await client.store({ content, tags: tags || [] });
    if (!result) {
      return { content: [{ type: 'text', text: 'Memory storage unavailable. Continuing without persistence.' }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              stored: true,
              emotion: result.emotion || result.feeling,
              state: result.state || result.limbicState,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── recall ────────────────────────────────────────────
server.tool(
  'recall',
  'Recall memories by semantic and emotional relevance. Returns full memory records with scores. Use `search` instead if you just need IDs and summaries (much cheaper in tokens).',
  {
    query: z.string().min(1).describe('Semantic search query'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  },
  async ({ query, limit }) => {
    const result = await client.recall({ query, limit });
    if (!result) {
      return { content: [{ type: 'text', text: JSON.stringify({ memories: [], error: 'unavailable' }) }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              found: result.memories?.length || 0,
              memories: (result.memories || []).map((m) => ({
                content: m.memory?.content || m.content,
                importance: m.memory?.importance || m.importance,
                score: m.finalScore || m.score,
                emotionalScore: m.emotionalScore,
                limbicResonance: m.limbicResonance,
              })),
              emotion: result.feeling,
              limbicState: result.limbicState,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── search (token-efficient) ─────────────────────────
server.tool(
  'search',
  'Token-efficient compact search. Returns only IDs and 120-char summaries — ~10x cheaper than recall. Use this first, then recall specific IDs if you need full content.',
  {
    query: z.string().min(1).describe('Search query'),
    limit: z.number().int().min(1).max(30).optional().describe('Max results (default 10)'),
  },
  async ({ query, limit }) => {
    const result = await client.searchCompact({ query, limit: limit || 10 });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              found: result.memories.length,
              results: result.memories,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ─── timeline ──────────────────────────────────────────
server.tool(
  'timeline',
  'Get recent memories chronologically. Useful for "what happened today/yesterday" questions.',
  {
    hours: z.number().int().min(1).max(168).optional().describe('Look back N hours (default 24)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
  },
  async ({ hours, limit }) => {
    const result = await client.timeline({ hours: hours || 24, limit: limit || 20 });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ─── emotion ───────────────────────────────────────────
server.tool(
  'emotion',
  'Get the current AI emotional state (Pleasure, Arousal, Dominance) and feeling label. Useful for adapting tone and LLM parameters.',
  {},
  async () => {
    const result = await client.emotion();
    if (!result) {
      return { content: [{ type: 'text', text: JSON.stringify({ feeling: 'unknown', error: 'unavailable' }) }] };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ─── forget ────────────────────────────────────────────
server.tool(
  'forget',
  'Delete specific memories by ID. Requires explicit IDs — will not bulk delete.',
  {
    memoryIds: z.array(z.string()).min(1).describe('Memory IDs to delete'),
  },
  async ({ memoryIds }) => {
    // The public API doesnt expose a DELETE endpoint yet — return a placeholder
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            requested: memoryIds,
            note: 'Forget endpoint is not yet exposed in the public REST API. Use recall with very specific tags and let natural decay handle it.',
          }),
        },
      ],
    };
  },
);

// ─── Start stdio transport ────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
