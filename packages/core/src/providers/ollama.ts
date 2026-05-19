// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Ollama provider adapter.
 *
 * Ollama (https://ollama.com) is the most common local-LLM runtime;
 * single-user Celiums users will most likely connect their Console to
 * an Ollama running on `http://localhost:11434` or the docker-compose
 * service name `http://ollama:11434`.
 *
 * Ollama exposes an OpenAI-compatible surface at `/v1/chat/completions`
 * plus a native `/api/tags` for model discovery. We use both.
 *
 * No API key required — Ollama is unauthenticated by design (run on
 * a trusted network). If the user puts Ollama behind a reverse proxy
 * with auth, they can set `apiKey` to whatever bearer the proxy
 * expects; we pass it through.
 */

import { registerProvider, type Provider, type ProviderConfig, type ProviderChatRequest, type ProviderModel, type ProviderTokenDelta, type ProviderUsage } from './index.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 120_000;

interface OllamaTag {
  name: string;
  size: number;
  details?: {
    family?: string;
    parameter_size?: string;
  };
  modified_at?: string;
}

interface OllamaTagsResponse {
  models?: OllamaTag[];
}

class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';
  readonly endpoint: string;
  readonly requiresKey = false;
  private apiKey: string | null;
  private timeoutMs: number;
  private _lastUsage: ProviderUsage | null = null;

  constructor(config: ProviderConfig) {
    this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey = config.apiKey ?? null;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(): Promise<ProviderModel[]> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, {
        method: 'GET',
        headers: this.headers(),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`ollama /api/tags returned ${res.status}`);
      const data = (await res.json()) as OllamaTagsResponse;
      const tags = data.models ?? [];
      return tags.map((t) => ({
        id: t.name,
        label: t.name,
        // Ollama doesn't report context length here; assume 8K as a safe default.
        // The user can override via UI when picking a model.
        context: 8192,
        tools: false,
        tier_hint: 'T0',
      }));
    } finally {
      clearTimeout(t);
    }
  }

  async test(): Promise<{ ok: boolean; latency_ms: number; models?: number; error?: string }> {
    const t0 = performance.now();
    try {
      const models = await this.listModels();
      return { ok: true, latency_ms: Math.round(performance.now() - t0), models: models.length };
    } catch (err) {
      return { ok: false, latency_ms: Math.round(performance.now() - t0), error: (err as Error).message };
    }
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ProviderTokenDelta> {
    this._lastUsage = null;
    const body = {
      model: req.model,
      messages: req.messages,
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.stop ? { stop: req.stop } : {}),
    };
    const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      yield { finish_reason: 'error', content: `[ollama ${res.status}] ${text}` };
      return;
    }
    if (!res.body) {
      yield { finish_reason: 'error', content: '[ollama empty body]' };
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
        // SSE format: lines starting with "data: " separated by blank lines.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]' || payload === '') continue;
          let chunk: {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            yield { content: choice.delta.content };
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
          if (choice?.finish_reason) {
            yield { finish_reason: choice.finish_reason as ProviderTokenDelta['finish_reason'] };
          }
        }
      }
    } finally {
      this._lastUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        // Ollama is local — zero marginal cost.
        cost_usd: 0,
      };
    }
  }

  lastUsage(): ProviderUsage | null {
    return this._lastUsage;
  }
}

registerProvider('ollama', (config) => new OllamaProvider(config));

export { OllamaProvider };
