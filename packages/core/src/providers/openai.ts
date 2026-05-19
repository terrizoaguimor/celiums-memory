// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * OpenAI / OpenAI-compatible provider adapter.
 *
 * Works with: OpenAI proper, DO Inference (`https://inference.do-ai.run/v1`),
 * Groq, Together, OpenRouter, LM Studio, vLLM, and any other service that
 * speaks the `/chat/completions` shape. Configure via `endpoint` + `apiKey`.
 *
 * For Anthropic-via-DO use this adapter (DO wraps Anthropic in OpenAI
 * shape). For direct Anthropic API use `./anthropic.ts`.
 */

import {
  registerProvider,
  type Provider,
  type ProviderConfig,
  type ProviderChatRequest,
  type ProviderModel,
  type ProviderTokenDelta,
  type ProviderUsage,
} from './index.js';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 120_000;

interface OpenAIModel {
  id: string;
  context_length?: number;
  capabilities?: { vision?: boolean; tools?: boolean };
}

interface OpenAIModelsResponse {
  data?: OpenAIModel[];
}

class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly requiresKey = true;
  private apiKey: string;
  private timeoutMs: number;
  private _lastUsage: ProviderUsage | null = null;

  constructor(id: string, name: string, config: ProviderConfig) {
    this.id = id;
    this.name = name;
    this.endpoint = (config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.apiKey) return [];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.endpoint}/models`, {
        method: 'GET',
        headers: this.headers(),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${this.id} /models returned ${res.status}`);
      const data = (await res.json()) as OpenAIModelsResponse;
      return (data.data ?? []).map((m) => ({
        id: m.id,
        context: m.context_length ?? 16384,
        vision: m.capabilities?.vision ?? false,
        tools: m.capabilities?.tools ?? true,
      }));
    } finally {
      clearTimeout(t);
    }
  }

  async test(): Promise<{ ok: boolean; latency_ms: number; models?: number; error?: string }> {
    const t0 = performance.now();
    if (!this.apiKey) {
      return { ok: false, latency_ms: 0, error: 'no api key configured' };
    }
    try {
      const models = await this.listModels();
      return { ok: true, latency_ms: Math.round(performance.now() - t0), models: models.length };
    } catch (err) {
      return { ok: false, latency_ms: Math.round(performance.now() - t0), error: (err as Error).message };
    }
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ProviderTokenDelta> {
    this._lastUsage = null;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.maxTokens !== undefined) body['max_completion_tokens'] = req.maxTokens;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.stop) body['stop'] = req.stop;
    if (req.tools) body['tools'] = req.tools;
    if (req.toolChoice) body['tool_choice'] = req.toolChoice;

    const res = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      yield { finish_reason: 'error', content: `[${this.id} ${res.status}] ${text.slice(0, 300)}` };
      return;
    }
    if (!res.body) {
      yield { finish_reason: 'error', content: `[${this.id} empty body]` };
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
          if (payload === '[DONE]' || payload === '') continue;
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
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
          if (choice?.delta?.reasoning_content) {
            yield { reasoning: choice.delta.reasoning_content };
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              yield {
                tool_call: {
                  index: tc.index,
                  ...(tc.id ? { id: tc.id } : {}),
                  ...(tc.function?.name ? { function_name: tc.function.name } : {}),
                  ...(tc.function?.arguments !== undefined
                    ? { function_arguments_delta: tc.function.arguments }
                    : {}),
                },
              };
            }
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
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
      };
    }
  }

  lastUsage(): ProviderUsage | null {
    return this._lastUsage;
  }
}

registerProvider('openai', (config) => new OpenAICompatProvider('openai', 'OpenAI', config));
registerProvider(
  'do-inference',
  (config) =>
    new OpenAICompatProvider('do-inference', 'DigitalOcean Inference', {
      ...config,
      endpoint: config.endpoint ?? 'https://inference.do-ai.run/v1',
    }),
);
registerProvider(
  'groq',
  (config) =>
    new OpenAICompatProvider('groq', 'Groq', {
      ...config,
      endpoint: config.endpoint ?? 'https://api.groq.com/openai/v1',
    }),
);
registerProvider(
  'openrouter',
  (config) =>
    new OpenAICompatProvider('openrouter', 'OpenRouter', {
      ...config,
      endpoint: config.endpoint ?? 'https://openrouter.ai/api/v1',
    }),
);
registerProvider(
  'together',
  (config) =>
    new OpenAICompatProvider('together', 'Together', {
      ...config,
      endpoint: config.endpoint ?? 'https://api.together.xyz/v1',
    }),
);
registerProvider(
  'lmstudio',
  (config) =>
    new OpenAICompatProvider('lmstudio', 'LM Studio', {
      ...config,
      endpoint: config.endpoint ?? 'http://localhost:1234/v1',
    }),
);
registerProvider(
  'vllm',
  (config) =>
    new OpenAICompatProvider('vllm', 'vLLM', {
      ...config,
      endpoint: config.endpoint ?? 'http://localhost:8000/v1',
    }),
);
registerProvider(
  'custom',
  (config) => new OpenAICompatProvider('custom', 'Custom OpenAI-compatible', config),
);

export { OpenAICompatProvider };
