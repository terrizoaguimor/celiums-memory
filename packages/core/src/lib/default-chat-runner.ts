// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Default `ChatRunner` implementation — pegamento entre la pipeline
 * declarada en `chat-runner.ts` y los provider adapters concretos
 * en `../providers/*`.
 *
 * Resolución de provider/model:
 *   1. Si la caller pasó `providerId` y `model`, usar eso.
 *   2. Si no, intentar el provider del usuario en `providers-store`
 *      (BYOK encriptada).
 *   3. Caer al managed provider (do-inference) usando
 *      `CELIUMS_LLM_API_KEY` + `CELIUMS_LLM_MODEL` del env.
 *
 * El runner emite eventos SSE en este orden:
 *   - `message.delta` por cada token / chunk de reasoning
 *   - `message.tool_call` si el modelo llama tools (raro en este path)
 *   - finish_reason llega via la última delta del provider
 *
 * El `runChat()` upstream se encarga de persistir la respuesta final
 * y disparar la pipeline de auto-memory; este módulo NO toca DB.
 */

import { createProvider, type Provider, type ProviderConfig } from '../providers/index.js';
import type { ProvidersStore } from './providers-store.js';
import type {
  ChatRunner,
  ChatRunnerInvocation,
  ChatRunnerResult,
} from './chat-runner.js';
import { CELIUMS_CHAT_TOOLS, TOOL_TO_MCP } from './chat-tools-catalog.js';

export interface DefaultChatRunnerOptions {
  /** Optional store with per-user BYOK creds. */
  providersStore: ProvidersStore | null;
  /** Managed fallback — used when the user has no BYOK configured. */
  managed: {
    providerId: string;
    apiKey: string;
    endpoint?: string;
    model: string;
  } | null;
  /** Default max tokens for the response. */
  defaultMaxTokens?: number;
  /** Default temperature. */
  defaultTemperature?: number;
}

/**
 * Resolve which provider+model to use for a given user. BYOK wins, then
 * managed fallback. Returns null if neither is available — the runner
 * surfaces a clear error in that case.
 */
async function resolveProvider(
  userId: string,
  opts: DefaultChatRunnerOptions,
): Promise<{ provider: Provider; model: string; source: 'byok' | 'managed' } | null> {
  // 1. BYOK: scan the user's configured providers (any one is fine —
  //    the Console will let the user pick later; for now we take the
  //    first one back from the store).
  if (opts.providersStore) {
    try {
      const stored = await opts.providersStore.list(userId);
      const first = stored[0];
      if (first) {
        const keyRecord = await opts.providersStore.getKey(userId, first.provider_id);
        if (keyRecord) {
          const cfg: ProviderConfig = { apiKey: keyRecord.apiKey };
          if (keyRecord.endpoint) cfg.endpoint = keyRecord.endpoint;
          const provider = createProvider(first.provider_id, cfg);
          // Pick the provider's first declared model as default; the
          // Console may override this once it lists models.
          const models = await provider.listModels().catch((): never[] => []);
          const model = models[0]?.id ?? opts.managed?.model ?? 'auto';
          return { provider, model, source: 'byok' };
        }
      }
    } catch (err) {
      // Non-fatal — fall through to managed.
      console.error('[chat-runner] BYOK resolve failed:', (err as Error).message);
    }
  }

  // 2. Managed fallback.
  if (opts.managed) {
    const cfg: ProviderConfig = { apiKey: opts.managed.apiKey };
    if (opts.managed.endpoint) cfg.endpoint = opts.managed.endpoint;
    const provider = createProvider(opts.managed.providerId, cfg);
    return { provider, model: opts.managed.model, source: 'managed' };
  }

  return null;
}

/**
 * Build a `ChatRunner` bound to a provider resolver. Returns a function
 * compatible with the `ChatRunner` type so it can be plugged into the
 * `runChat()` orchestrator in chat-runner.ts.
 */
export function createDefaultChatRunner(opts: DefaultChatRunnerOptions): ChatRunner {
  return async (
    inv: ChatRunnerInvocation,
    onEvent,
  ): Promise<ChatRunnerResult> => {
    // 1. If the caller passed an explicit override, honour it (Console
    //    dropdown). Resolve api key from BYOK store first, then managed.
    let resolved: { provider: Provider; model: string; source: 'override' | 'byok' | 'managed' } | null = null;
    if (inv.providerOverride) {
      const { providerId, model } = inv.providerOverride;
      // BYOK key for that specific provider?
      let cfg: ProviderConfig | null = null;
      if (opts.providersStore) {
        const keyRecord = await opts.providersStore.getKey(inv.userId, providerId).catch((): null => null);
        if (keyRecord) {
          cfg = { apiKey: keyRecord.apiKey };
          if (keyRecord.endpoint) cfg.endpoint = keyRecord.endpoint;
        }
      }
      // Fall back to managed creds when the override hits the same
      // managed provider id.
      if (!cfg && opts.managed && opts.managed.providerId === providerId) {
        cfg = { apiKey: opts.managed.apiKey };
        if (opts.managed.endpoint) cfg.endpoint = opts.managed.endpoint;
      }
      if (cfg) {
        resolved = { provider: createProvider(providerId, cfg), model, source: 'override' };
      }
    }
    // 2. Otherwise the runner picks its own default.
    if (!resolved) {
      resolved = await resolveProvider(inv.userId, opts);
    }
    if (!resolved) {
      throw new Error(
        'No provider configured. Add one in /settings or set CELIUMS_LLM_API_KEY env.',
      );
    }
    const { provider, model } = resolved;

    // Map history into provider shape (agent → assistant).
    const messages = inv.history.map((m) => ({
      role: (m.role === 'agent' ? 'assistant' : m.role) as
        | 'system'
        | 'user'
        | 'assistant'
        | 'tool',
      content: m.content,
    }));
    // Prepend systemContext (memorias + journal + persona) si vino.
    // Esto es lo que el modelo ve antes de cualquier history textual.
    if (inv.systemContext) {
      messages.unshift({ role: 'system', content: inv.systemContext });
    }
    // Ensure the latest user message is the tail (history already
    // contains the persisted user row from runChat upstream).
    if (
      messages.length === 0 ||
      messages[messages.length - 1]?.role !== 'user' ||
      messages[messages.length - 1]?.content !== inv.userText
    ) {
      messages.push({ role: 'user', content: inv.userText });
    }

    let assembled = '';
    let reasoning = '';
    let hasToolCall = false;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCostUsd = 0;
    const streamingId = `${inv.conversationId}:streaming`;
    const MAX_TOOL_ITERATIONS = 5;

    // Tool-use loop: provider.chat() → if it requests tool_calls,
    // execute them and feed results back. Bounded to MAX iterations
    // to prevent infinite loops.
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
      const req = {
        model,
        messages,
        maxTokens: opts.defaultMaxTokens ?? 4096,
        temperature: opts.defaultTemperature ?? 0.7,
        ...(inv.toolExecutor
          ? {
              tools: CELIUMS_CHAT_TOOLS as unknown as unknown[],
              toolChoice: 'auto' as const,
            }
          : {}),
      };

      // Accumulators for THIS iteration only.
      type PartialToolCall = {
        id: string;
        function_name: string;
        function_arguments: string;
      };
      const partialToolCalls = new Map<number, PartialToolCall>();
      let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | undefined;

      for await (const delta of provider.chat(req)) {
        if (delta.content) {
          assembled += delta.content;
          onEvent({
            type: 'message.token',
            conversation_id: inv.conversationId,
            message_id: streamingId,
            token: delta.content,
          });
        }
        if (delta.reasoning) {
          reasoning += delta.reasoning;
        }
        if (delta.tool_call) {
          hasToolCall = true;
          const idx = delta.tool_call.index;
          const prev = partialToolCalls.get(idx) ?? {
            id: '',
            function_name: '',
            function_arguments: '',
          };
          if (delta.tool_call.id) prev.id = delta.tool_call.id;
          if (delta.tool_call.function_name) prev.function_name = delta.tool_call.function_name;
          if (delta.tool_call.function_arguments_delta) {
            prev.function_arguments += delta.tool_call.function_arguments_delta;
          }
          partialToolCalls.set(idx, prev);
        }
        if (delta.finish_reason) {
          finishReason = delta.finish_reason;
        }
      }

      const usage = provider.lastUsage();
      if (usage) {
        totalTokensIn += usage.prompt_tokens;
        totalTokensOut += usage.completion_tokens;
        if (usage.cost_usd !== undefined) totalCostUsd += usage.cost_usd;
      }

      // No tool calls → assistant turn is done.
      if (finishReason !== 'tool_calls' || partialToolCalls.size === 0 || !inv.toolExecutor) {
        break;
      }

      // Append the assistant's tool-call request to history so the
      // provider sees what it asked for when we re-call. The assistant
      // message MUST carry `tool_calls` per OpenAI spec — otherwise the
      // model re-invokes the same tool thinking it never happened.
      const assistantToolCalls = Array.from(partialToolCalls.values());
      const assistantMsg: {
        role: 'assistant';
        content: string;
        tool_calls?: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }>;
      } = {
        role: 'assistant',
        content: assembled,
        tool_calls: assistantToolCalls.map((c) => ({
          id: c.id || `call_${Math.random().toString(36).slice(2, 12)}`,
          type: 'function',
          function: {
            name: c.function_name,
            arguments: c.function_arguments || '{}',
          },
        })),
      };
      messages.push(assistantMsg as unknown as typeof messages[number]);

      // Execute each tool call.
      for (const call of assistantToolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(call.function_arguments || '{}');
        } catch {
          parsedArgs = { _raw_arguments: call.function_arguments };
        }
        // Coerce common bad shapes: tags as JSON-encoded string → array.
        if (typeof parsedArgs['tags'] === 'string') {
          try {
            const maybeArr = JSON.parse(parsedArgs['tags'] as string);
            if (Array.isArray(maybeArr)) parsedArgs['tags'] = maybeArr;
            else parsedArgs['tags'] = [parsedArgs['tags']];
          } catch {
            parsedArgs['tags'] = [parsedArgs['tags'] as string];
          }
        }
        // Coerce valence string → number.
        if (typeof parsedArgs['valence'] === 'string') {
          const n = parseFloat(parsedArgs['valence'] as string);
          if (!Number.isNaN(n)) parsedArgs['valence'] = n;
        }
        // Coerce importance string → number.
        if (typeof parsedArgs['importance'] === 'string') {
          const n = parseFloat(parsedArgs['importance'] as string);
          if (!Number.isNaN(n)) parsedArgs['importance'] = n;
        }

        const mcpToolName = TOOL_TO_MCP[call.function_name] ?? call.function_name;
        const callId = call.id || `call_${Math.random().toString(36).slice(2, 12)}`;

        onEvent({
          type: 'message.tool_call',
          message_id: streamingId,
          skill_id: call.function_name,
          inputs: parsedArgs,
        });

        let result: unknown = null;
        try {
          result = await inv.toolExecutor(mcpToolName, parsedArgs);
        } catch (err) {
          result = { error: (err as Error).message };
        }

        const isError = result && typeof result === 'object' && 'error' in (result as object);
        onEvent({
          type: 'message.tool_result',
          message_id: streamingId,
          skill_id: call.function_name,
          output: result,
          status: isError ? 'error' : 'success',
        });

        // Append tool result to history so the next provider call sees it.
        // The role='tool' message MUST carry `tool_call_id` matching the
        // assistant's tool_calls[i].id, per OpenAI spec.
        const resultText =
          typeof result === 'string'
            ? result
            : JSON.stringify(result ?? null);
        const toolMsg: {
          role: 'tool';
          content: string;
          tool_call_id: string;
        } = {
          role: 'tool',
          content: resultText,
          tool_call_id: callId,
        };
        messages.push(toolMsg as unknown as typeof messages[number]);
      }
    }

    const result: ChatRunnerResult = {
      text: assembled,
      model,
      hasToolCall,
    };
    if (reasoning) result.reasoning = reasoning;
    if (totalTokensIn > 0) result.tokensIn = totalTokensIn;
    if (totalTokensOut > 0) result.tokensOut = totalTokensOut;
    if (totalCostUsd > 0) result.costUsd = totalCostUsd;
    return result;
  };
}

/**
 * Read the managed-fallback config from process.env. Returns null if
 * the env isn't set — in that case the runner will require BYOK to
 * answer.
 */
export function managedFromEnv(): DefaultChatRunnerOptions['managed'] {
  const apiKey = process.env['CELIUMS_LLM_API_KEY'];
  if (!apiKey) return null;
  const model = process.env['CELIUMS_LLM_MODEL'] ?? 'anthropic-claude-4.6-sonnet';
  const endpoint = process.env['CELIUMS_LLM_BASE_URL'] ?? 'https://inference.do-ai.run/v1';
  // The DO Inference fleet is exposed as 'do-inference' in the registry.
  return { providerId: 'do-inference', apiKey, model, endpoint };
}
