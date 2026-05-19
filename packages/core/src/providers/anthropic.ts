// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Anthropic provider adapter — direct integration with the Messages API.
 *
 * For users who BYO an Anthropic API key (sk-ant-*). Uses `/v1/messages`,
 * NOT `/v1/chat/completions`. The shape diverges enough that we
 * translate locally rather than pretending Anthropic is OpenAI.
 *
 * If the user wants Claude via DigitalOcean Inference, use the
 * `do-inference` provider id from `./openai.ts` — DO speaks OpenAI shape.
 */

import {
  registerProvider,
  type Provider,
  type ProviderConfig,
  type ProviderChatRequest,
  type ProviderMessage,
  type ProviderModel,
  type ProviderTokenDelta,
  type ProviderUsage,
} from './index.js';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 180_000;
const ANTHROPIC_VERSION = '2023-06-01';

// Anthropic has no /models endpoint; this is a curated list as of 2026-05.
const KNOWN_MODELS: ProviderModel[] = [
  { id: 'claude-opus-4-7', context: 200000, vision: true, tools: true, tier_hint: 'T1' },
  { id: 'claude-sonnet-4-6', context: 200000, vision: true, tools: true, tier_hint: 'T2' },
  { id: 'claude-haiku-4-5', context: 200000, vision: true, tools: true, tier_hint: 'T0' },
];

class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  readonly endpoint: string;
  readonly requiresKey = true;
  private apiKey: string;
  private timeoutMs: number;
  private _lastUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    // Anthropic doesn't expose /models; return the curated set.
    return [...KNOWN_MODELS];
  }

  async test(): Promise<{ ok: boolean; latency_ms: number; models?: number; error?: string }> {
    const t0 = performance.now();
    if (!this.apiKey) {
      return { ok: false, latency_ms: 0, error: 'no api key configured' };
    }
    // Send a tiny ping completion to validate the key.
    try {
      const res = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ok' }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, latency_ms: Math.round(performance.now() - t0), error: `${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true, latency_ms: Math.round(performance.now() - t0), models: KNOWN_MODELS.length };
    } catch (err) {
      return { ok: false, latency_ms: Math.round(performance.now() - t0), error: (err as Error).message };
    }
  }

  /**
   * Translate OpenAI-style messages into Anthropic's shape:
   *   - system role → top-level `system` field
   *   - user/assistant → messages array
   *   - tool role → user with tool_result block (simplified)
   */
  private translate(messages: ProviderMessage[]): {
    system: string | undefined;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    let system: string | undefined;
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = system ? `${system}\n\n${m.content}` : m.content;
        continue;
      }
      if (m.role === 'tool') {
        out.push({ role: 'user', content: `[tool result] ${m.content}` });
        continue;
      }
      if (m.role === 'user' || m.role === 'assistant') {
        out.push({ role: m.role, content: m.content });
      }
    }
    return { system, messages: out };
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ProviderTokenDelta> {
    this._lastUsage = null;
    const { system, messages } = this.translate(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      max_tokens: req.maxTokens ?? 4096,
    };
    if (system !== undefined) body['system'] = system;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.stop) body['stop_sequences'] = req.stop;

    const res = await fetch(`${this.endpoint}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      yield { finish_reason: 'error', content: `[anthropic ${res.status}] ${text.slice(0, 300)}` };
      return;
    }
    if (!res.body) {
      yield { finish_reason: 'error', content: '[anthropic empty body]' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '' || payload === '[DONE]') continue;
          let evt: {
            type?: string;
            delta?: { type?: string; text?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          // Streaming event types per Anthropic spec:
          //   message_start, content_block_start, content_block_delta,
          //   content_block_stop, message_delta, message_stop.
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            yield { content: evt.delta.text ?? '' };
            continue;
          }
          if (evt.type === 'message_start' && evt.message?.usage) {
            promptTokens = evt.message.usage.input_tokens ?? 0;
            continue;
          }
          if (evt.type === 'message_delta' && evt.usage) {
            completionTokens = evt.usage.output_tokens ?? completionTokens;
            continue;
          }
          if (evt.type === 'message_stop') {
            yield { finish_reason: 'stop' };
            continue;
          }
        }
      }
    } finally {
      this._lastUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }
  }

  lastUsage(): ProviderUsage | null {
    return this._lastUsage;
  }
}

registerProvider('anthropic', (config) => new AnthropicProvider(config));

export { AnthropicProvider };
