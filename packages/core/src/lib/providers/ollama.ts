// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Ollama adapter — local-first inference for self-hosted users.
 *
 * The @langchain/* providers don't cover Ollama; we use the official
 * `ollama` npm client which speaks the Ollama REST API. The adapter
 * exposes chat + embeddings.
 *
 * Default host: http://localhost:11434. Override with opts.baseUrl.
 */

import type { LlmAdapter, ChatRequest, ChatResponse, EmbedRequest, EmbedResponse } from './types.js';
import { ProviderUnavailable, ProviderRequestError } from './types.js';

export function createOllamaAdapter(opts: {
  baseUrl?: string;
  defaultModel?: string;
  defaultEmbedModel?: string;
}): LlmAdapter {
  return {
    providerId: 'ollama',
    name: 'Ollama (local)',

    async chat(req: ChatRequest): Promise<ChatResponse> {
      let mod: any;
      try {
        mod = await import('ollama');
      } catch (err) {
        throw new ProviderUnavailable('ollama', 'ollama npm package not installed');
      }
      const { Ollama } = mod;
      if (!Ollama) {
        throw new ProviderUnavailable('ollama', 'ollama npm package shape changed — Ollama export missing');
      }
      const client = new Ollama({ host: opts.baseUrl ?? 'http://localhost:11434' });

      const model = req.model || opts.defaultModel || 'llama3.2';

      let resp: any;
      try {
        resp = await client.chat({
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          options: {
            temperature: req.temperature,
            num_predict: req.maxTokens,
            top_p: req.topP,
            stop: req.stop,
          },
          stream: false,
        });
      } catch (err) {
        throw new ProviderRequestError(`ollama: chat failed — ${(err as Error).message}`, err);
      }

      return {
        content: resp.message?.content ?? '',
        modelUsed: resp.model ?? model,
        usage: {
          promptTokens: resp.prompt_eval_count,
          completionTokens: resp.eval_count,
          totalTokens: (resp.prompt_eval_count ?? 0) + (resp.eval_count ?? 0),
        },
        finishReason: resp.done_reason ?? (resp.done ? 'stop' : undefined),
      };
    },

    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      let mod: any;
      try {
        mod = await import('ollama');
      } catch (err) {
        throw new ProviderUnavailable('ollama', 'ollama npm package not installed');
      }
      const { Ollama } = mod;
      const client = new Ollama({ host: opts.baseUrl ?? 'http://localhost:11434' });

      const model = req.model || opts.defaultEmbedModel || 'nomic-embed-text';
      const texts = Array.isArray(req.input) ? req.input : [req.input];

      const embeddings: number[][] = [];
      for (const text of texts) {
        try {
          const resp = await client.embeddings({ model, prompt: text });
          embeddings.push(resp.embedding ?? []);
        } catch (err) {
          throw new ProviderRequestError(`ollama: embed failed — ${(err as Error).message}`, err);
        }
      }

      return {
        embeddings,
        modelUsed: model,
        dimensions: embeddings[0]?.length,
      };
    },

    async *stream(req: ChatRequest) {
      let mod: any;
      try {
        mod = await import('ollama');
      } catch (err) {
        throw new ProviderUnavailable('ollama', 'ollama npm package not installed');
      }
      const { Ollama } = mod;
      const client = new Ollama({ host: opts.baseUrl ?? 'http://localhost:11434' });

      const model = req.model || opts.defaultModel || 'llama3.2';
      let stream: any;
      try {
        stream = await client.chat({
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          options: {
            temperature: req.temperature,
            num_predict: req.maxTokens,
            top_p: req.topP,
            stop: req.stop,
          },
          stream: true,
        });
      } catch (err) {
        throw new ProviderRequestError(`ollama: stream open failed — ${(err as Error).message}`, err);
      }

      for await (const chunk of stream) {
        yield {
          delta: chunk.message?.content ?? '',
          finishReason: chunk.done ? (chunk.done_reason ?? 'stop') : undefined,
          usage: chunk.done ? {
            promptTokens: chunk.prompt_eval_count,
            completionTokens: chunk.eval_count,
            totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
          } : undefined,
        };
      }
    },
  };
}
