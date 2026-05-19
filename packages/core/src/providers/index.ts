// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Provider adapters — multi-provider chat + embeddings abstraction.
 *
 * Used by `/v1/conversations/:id/messages` to fan a turn out to any
 * configured LLM provider (Ollama local, Anthropic, OpenAI, DO Inference,
 * Groq, Together, OpenRouter, LM Studio, vLLM…).
 *
 * Design:
 *
 *   - The `Provider` interface is the contract every adapter implements.
 *   - Providers are discovered from `llm-providers.ts` (metadata) and
 *     instantiated via `createProvider(id, config)`.
 *   - All adapters speak the OpenAI-compatible /chat/completions wire
 *     shape internally — that's the lingua franca. Anthropic is the
 *     only one that needs translation (its /v1/messages API differs);
 *     its adapter does the translation.
 *   - Streaming uses async iterators returning string deltas. The
 *     route handler in quickstart.ts wraps these into SSE events.
 */

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Optional tool call info — for providers that support tool use. */
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
}

export interface ProviderChatRequest {
  model: string;
  messages: ProviderMessage[];
  /** Stop when the model emits one of these strings (delegated to provider). */
  stop?: string[];
  /** Max tokens of output. Each provider has its own cap. */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Pass-through tools array for OpenAI-compat providers. */
  tools?: unknown[];
  toolChoice?: 'auto' | 'none' | 'required';
  /** Optional abort signal — wire up `request.signal` from Node http. */
  signal?: AbortSignal;
}

export interface ProviderTokenDelta {
  /** A chunk of assistant content. */
  content?: string;
  /** Reasoning content (Claude/DeepSeek/etc emit this separately). */
  reasoning?: string;
  /** Partial tool call chunk. */
  tool_call?: {
    index: number;
    id?: string;
    function_name?: string;
    function_arguments_delta?: string;
  };
  /** Finish signal — finalises the stream. */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
}

export interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** USD cost computed by the adapter, when prices are known. */
  cost_usd?: number;
}

export interface ProviderModel {
  id: string;
  label?: string;
  context: number;
  vision?: boolean;
  tools?: boolean;
  /** Hint about cost class — informational only, atlas decides routing. */
  tier_hint?: 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
}

export interface Provider {
  /** Provider id (matches LlmProviderId). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Endpoint URL the adapter talks to. */
  endpoint: string;
  /** True if the adapter requires an API key from the caller. */
  requiresKey: boolean;

  /** Discover models available on this provider. May be a network call. */
  listModels(): Promise<ProviderModel[]>;

  /** Health check — returns true + latency on success. */
  test(): Promise<{ ok: boolean; latency_ms: number; models?: number; error?: string }>;

  /**
   * Stream a chat completion. Yields `ProviderTokenDelta` chunks. The
   * final yielded value MUST include `finish_reason`. Usage is emitted
   * via the returned promise once the stream closes.
   */
  chat(req: ProviderChatRequest): AsyncIterable<ProviderTokenDelta>;

  /** Fetch usage of the last chat call — populated after the stream ends. */
  lastUsage(): ProviderUsage | null;
}

export interface ProviderConfig {
  /** Override the default endpoint. */
  endpoint?: string;
  /** API key (for providers that need it). */
  apiKey?: string;
  /** Optional default model id. */
  defaultModel?: string;
  /** Optional timeout in ms (per request). */
  timeoutMs?: number;
}

export type ProviderFactory = (config: ProviderConfig) => Provider;

const REGISTRY = new Map<string, ProviderFactory>();

export function registerProvider(id: string, factory: ProviderFactory): void {
  REGISTRY.set(id, factory);
}

export function createProvider(id: string, config: ProviderConfig): Provider {
  const factory = REGISTRY.get(id);
  if (!factory) {
    throw new Error(
      `Unknown provider '${id}'. Register it via registerProvider() or import its adapter from packages/core/src/providers/<id>.ts`,
    );
  }
  return factory(config);
}

export function listRegisteredProviders(): string[] {
  return Array.from(REGISTRY.keys());
}
