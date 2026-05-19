// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Chat runner — orchestrates the agent reply pipeline for a single user
 * turn. Called by `/v1/conversations/:id/messages` after the user message
 * is persisted.
 *
 * Steps:
 *   1. Resolve provider + model (from Atlas decision or from caller hint).
 *   2. Open provider stream.
 *   3. Forward token deltas via broker.publish → SSE clients.
 *   4. Persist the final agent message with usage + cost.
 *   5. Run auto-memory pipeline; persist memory if importance >= 0.4.
 *
 * This module is intentionally minimal — it depends on a `ChatRunner`
 * interface so the consumer (quickstart.ts) can inject the actual
 * provider resolution + memory persistence logic without circular
 * imports between core modules.
 */

import { broker, channelKey, newRequestId, type CeliumsEvent } from './sse-broker.js';
import type { ConversationsStore, MessageRow } from './conversations-store.js';
import {
  proposeMemory,
  scoreImportance,
  type MemoryProposal,
} from './auto-memory.js';
import { buildTurnContext } from './context-builder.js';
import { dispatchMcp } from '../mcp/dispatcher.js';

export interface ChatRunnerInvocation {
  conversationId: string;
  userId: string;
  tenantId: string;
  userText: string;
  history: { role: 'user' | 'agent' | 'system' | 'tool'; content: string }[];
  /** Caller-supplied provider/model. Overrides the runner's default
   *  resolution (BYOK → managed fallback). The Console passes these
   *  from its dropdown selection. */
  providerOverride?: { providerId: string; model: string };
  /** Pre-built system prompt (memories + journal + persona). When
   *  present, the provider runner prepends it as a system message to
   *  the messages array. Built by `buildTurnContext`. */
  systemContext?: string;
  /** Optional executor for tool calls invoked by the agent. Receives the
   *  MCP tool name + args, runs through `dispatchMcp`, returns the
   *  parsed result (or null on failure). When present, the runner
   *  passes the tool catalog to the provider and handles tool_calls
   *  in a loop. */
  toolExecutor?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface ChatRunnerResult {
  /** Final agent text after the stream closes. */
  text: string;
  /** Optional reasoning block (collapsed in the UI). */
  reasoning?: string;
  /** Atlas tier picked. */
  tier?: 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** Whether the agent invoked tools (informs auto-memory importance). */
  hasToolCall?: boolean;
}

/**
 * Implemented by the consumer. Yields token-level events that the runner
 * publishes verbatim to the SSE broker. The promise resolves with the
 * final assembled result.
 */
export interface ChatRunner {
  (
    inv: ChatRunnerInvocation,
    onEvent: (event: CeliumsEvent) => void,
  ): Promise<ChatRunnerResult>;
}

export interface RunChatInput {
  runner: ChatRunner;
  userId: string;
  tenantId: string;
  conversationId: string;
  userMessage: { id: string; content: string };
  store: ConversationsStore;
  /** Optional: memory persister callback (returns the created memory id). */
  persistMemory?: (m: MemoryProposal) => Promise<string | null>;
  /** Optional: locale hint for auto-memory heuristics. */
  locale?: 'es' | 'en';
  /** Optional: provider/model override flowed from POST body. */
  providerOverride?: { providerId: string; model: string };
  /** Optional: MCP context for pre-turn recall + journal_recall. When
   *  present, `runChat` builds a system prompt with memorias + journal
   *  (own + predecessors) and threads it through invocation.systemContext. */
  contextBuilder?: {
    mcpCtx: import('../mcp/types.js').McpToolContext;
    modelAgentId: string;
    predecessorAgentIds: string[];
  };
}

export async function runChat(input: RunChatInput): Promise<void> {
  const ch = channelKey(input.tenantId, input.userId, {
    conversationId: input.conversationId,
  });

  // Reconstruct recent history for the runner.
  const { rows: history } = await input.store.listMessages({
    userId: input.userId,
    conversationId: input.conversationId,
    limit: 50,
  });
  const messages = history
    .filter((m: MessageRow) => m.role === 'user' || m.role === 'agent' || m.role === 'system')
    .map((m: MessageRow) => ({
      role: m.role as 'user' | 'agent' | 'system',
      content: m.content,
    }));

  // Tell the broker the agent is starting (sense channel pulses on).
  broker.publish(ch, {
    type: 'channel.active',
    conversation_id: input.conversationId,
    channel: 'sense',
  });

  // Build pre-turn context: recall del usuario + journal del modelo +
  // journal de predecesores. Esto es lo que vuelve cross-modelo coherente.
  let systemContext: string | undefined;
  if (input.contextBuilder) {
    try {
      const built = await buildTurnContext({
        userMessage: input.userMessage.content,
        userId: input.userId,
        modelAgentId: input.contextBuilder.modelAgentId,
        predecessorAgentIds: input.contextBuilder.predecessorAgentIds,
        mcpCtx: input.contextBuilder.mcpCtx,
      });
      systemContext = built.systemPrompt;
      console.log(
        `[context-builder] memories=${built.memoriesUsed} ownJournal=${built.ownJournalUsed} inheritedJournal=${built.inheritedJournalUsed} model=${input.contextBuilder.modelAgentId}`,
      );
    } catch (err) {
      console.error('[context-builder] failed:', (err as Error).message);
      // No fatal — el chat sigue sin context enriquecido.
    }
  }

  // Build tool executor that uses dispatchMcp with the right agent_id.
  let toolExecutor: ChatRunnerInvocation['toolExecutor'];
  if (input.contextBuilder) {
    const mcpCtx = input.contextBuilder.mcpCtx;
    toolExecutor = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      const envelope = {
        jsonrpc: '2.0' as const,
        id: newRequestId(),
        method: 'tools/call' as const,
        params: { name, arguments: args },
      };
      try {
        const r = (await dispatchMcp(envelope, mcpCtx, process.env)) as {
          result?: { content?: Array<{ text?: string }> };
          error?: { message?: string };
        };
        if (r.error) return { error: r.error.message };
        const first = r.result?.content?.[0]?.text;
        if (!first) return null;
        try {
          return JSON.parse(first);
        } catch {
          return first;
        }
      } catch (err) {
        return { error: (err as Error).message };
      }
    };
  }

  let result: ChatRunnerResult;
  try {
    result = await input.runner(
      {
        conversationId: input.conversationId,
        userId: input.userId,
        tenantId: input.tenantId,
        userText: input.userMessage.content,
        history: messages,
        ...(input.providerOverride
          ? { providerOverride: input.providerOverride }
          : {}),
        ...(systemContext ? { systemContext } : {}),
        ...(toolExecutor ? { toolExecutor } : {}),
      },
      (event) => broker.publish(ch, event),
    );
  } catch (err) {
    // Surface a tool-result-error so the Console renders a clear failure.
    broker.publish(ch, {
      type: 'message.tool_result',
      message_id: input.userMessage.id,
      skill_id: 'chat:runner',
      output: { error: (err as Error).message },
      status: 'error',
    });
    return;
  } finally {
    broker.publish(ch, {
      type: 'channel.idle',
      conversation_id: input.conversationId,
      channel: 'communicate',
    });
  }

  // Persist the agent message.
  const agentMessage = await input.store.insertMessage({
    conversationId: input.conversationId,
    role: 'agent',
    content: result.text,
    tier: result.tier ?? null,
    model: result.model ?? null,
    reasoning: result.reasoning ?? null,
    tokensIn: result.tokensIn ?? null,
    tokensOut: result.tokensOut ?? null,
    costUsd: result.costUsd ?? null,
  });

  broker.publish(ch, {
    type: 'message.done',
    conversation_id: input.conversationId,
    message_id: agentMessage.id,
    tokens: { in: result.tokensIn ?? 0, out: result.tokensOut ?? 0 },
  });

  // Auto-memory: extract if importance crosses threshold.
  const turn: Parameters<typeof scoreImportance>[0] = {
    userText: input.userMessage.content,
    agentText: result.text,
    ...(result.hasToolCall !== undefined ? { hasToolCall: result.hasToolCall } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
  };
  const decision = scoreImportance(turn);

  if (decision.shouldPersist && input.persistMemory) {
    const proposal = proposeMemory(turn);
    try {
      const memoryId = await input.persistMemory(proposal);
      if (memoryId) {
        await input.store.linkMemory({
          messageId: agentMessage.id,
          memoryId,
          extraction: 'llm_extract',
        });
        broker.publish(ch, {
          type: 'memory.created',
          memory_id: memoryId,
          valence: proposal.valence,
          importance: proposal.importance,
          tags: proposal.tags,
        });
      }
    } catch (err) {
      console.error('[chat-runner] auto-memory failed:', (err as Error).message);
    }
  }
}
