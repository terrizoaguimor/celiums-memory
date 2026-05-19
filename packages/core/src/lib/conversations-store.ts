// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Conversations + messages CRUD wrapper.
 *
 * Postgres-backed (schema in `scripts/migrations/011_conversations.sql`).
 * Used by `/v1/conversations/*` route handlers and by the auto-memory
 * pipeline that links generated memories back to source messages.
 */

import type { Pool } from 'pg';

export type MessageRole = 'user' | 'agent' | 'system' | 'tool';
export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface ConversationRow {
  id: string;
  user_id: string;
  tenant_id: string;
  title: string | null;
  agent_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  message_count?: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tier: Tier | null;
  model: string | null;
  reasoning: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  atlas_decision_id: string | null;
  parent_id: string | null;
  created_at: string;
}

export class ConversationsStore {
  constructor(private pool: Pool) {}

  async create(args: {
    userId: string;
    tenantId: string;
    title: string | null;
    agentId?: string;
  }): Promise<ConversationRow> {
    const r = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations (user_id, tenant_id, title, agent_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, tenant_id, title, agent_id,
                 to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                 to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
                 archived_at`,
      [args.userId, args.tenantId, args.title, args.agentId ?? 'celiums'],
    );
    return r.rows[0]!;
  }

  async get(args: { userId: string; conversationId: string }): Promise<ConversationRow | null> {
    const r = await this.pool.query<ConversationRow>(
      `SELECT id, user_id, tenant_id, title, agent_id,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
              to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
              archived_at,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id)::int AS message_count
         FROM conversations
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [args.conversationId, args.userId],
    );
    return r.rows[0] ?? null;
  }

  async list(args: {
    userId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ rows: ConversationRow[]; nextCursor: string | null }> {
    const limit = Math.min(args.limit ?? 25, 100);
    const cursorClause = args.cursor ? `AND updated_at < $3` : '';
    const params: unknown[] = [args.userId, limit + 1];
    if (args.cursor) params.push(args.cursor);
    const r = await this.pool.query<ConversationRow>(
      `SELECT id, user_id, tenant_id, title, agent_id,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
              to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
              archived_at
         FROM conversations
        WHERE user_id = $1 AND archived_at IS NULL ${cursorClause}
        ORDER BY updated_at DESC
        LIMIT $2`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const nextCursor = r.rows.length > limit ? r.rows[limit - 1]!.updated_at : null;
    return { rows, nextCursor };
  }

  async archive(args: { userId: string; conversationId: string }): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE conversations SET archived_at = now()
        WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [args.conversationId, args.userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async updateTitle(args: {
    userId: string;
    conversationId: string;
    title: string;
  }): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE conversations SET title = $1, updated_at = now()
        WHERE id = $2 AND user_id = $3 AND archived_at IS NULL`,
      [args.title, args.conversationId, args.userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async insertMessage(args: {
    conversationId: string;
    role: MessageRole;
    content: string;
    tier?: Tier | null;
    model?: string | null;
    reasoning?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: number | null;
    atlasDecisionId?: string | null;
    parentId?: string | null;
  }): Promise<MessageRow> {
    const r = await this.pool.query<MessageRow>(
      `INSERT INTO messages
         (conversation_id, role, content, tier, model, reasoning,
          tokens_in, tokens_out, cost_usd, atlas_decision_id, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, conversation_id, role, content, tier, model, reasoning,
                 tokens_in, tokens_out, cost_usd, atlas_decision_id, parent_id,
                 to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at`,
      [
        args.conversationId,
        args.role,
        args.content,
        args.tier ?? null,
        args.model ?? null,
        args.reasoning ?? null,
        args.tokensIn ?? null,
        args.tokensOut ?? null,
        args.costUsd ?? null,
        args.atlasDecisionId ?? null,
        args.parentId ?? null,
      ],
    );
    return r.rows[0]!;
  }

  async listMessages(args: {
    conversationId: string;
    userId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<{ rows: MessageRow[]; nextCursor: string | null }> {
    // Verify ownership first.
    const owned = await this.get({ userId: args.userId, conversationId: args.conversationId });
    if (!owned) return { rows: [], nextCursor: null };

    const limit = Math.min(args.limit ?? 50, 200);
    const cursorClause = args.cursor ? `AND created_at > $3` : '';
    const params: unknown[] = [args.conversationId, limit + 1];
    if (args.cursor) params.push(args.cursor);
    const r = await this.pool.query<MessageRow>(
      `SELECT id, conversation_id, role, content, tier, model, reasoning,
              tokens_in, tokens_out, cost_usd, atlas_decision_id, parent_id,
              to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM messages
        WHERE conversation_id = $1 ${cursorClause}
        ORDER BY created_at ASC
        LIMIT $2`,
      params,
    );
    const rows = r.rows.slice(0, limit);
    const nextCursor = r.rows.length > limit ? r.rows[limit - 1]!.created_at : null;
    return { rows, nextCursor };
  }

  async linkMemory(args: {
    messageId: string;
    memoryId: string;
    extraction?: 'inline_triple' | 'llm_extract' | 'user_pin';
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO message_memories (message_id, memory_id, extraction)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, memory_id) DO NOTHING`,
      [args.messageId, args.memoryId, args.extraction ?? 'llm_extract'],
    );
  }
}
