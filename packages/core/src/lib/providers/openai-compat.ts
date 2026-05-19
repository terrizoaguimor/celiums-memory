// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * OpenAI-compatible adapter — works with any service that exposes the
 * OpenAI /v1/chat/completions + /v1/embeddings contract.
 *
 * Tested targets (all proven in prod for Celiums):
 *   - OpenAI direct
 *   - DigitalOcean Inference (inference.do-ai.run)
 *   - OpenRouter, Together, Groq
 *   - LM Studio, vLLM, Ollama's /v1/ shim
 *
 * This adapter is the ROOT default for the library — if no provider is
 * specified via env, we fall back to this. It also delegates the fetch
 * machinery to the legacy `llmChat` / `llmEmbed` helpers in
 * `../../llm-client.ts` so we don't duplicate timeout + auth handling.
 */

import type { LlmAdapter, ChatRequest, ChatResponse, EmbedRequest, EmbedResponse } from './types.js';
import { ProviderRequestError } from './types.js';
import { llmChat, llmEmbed } from '../../llm-client.js';

export function createOpenAICompatAdapter(opts: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultEmbedModel?: string;
  timeoutMs?: number;
}): LlmAdapter {
  // Build an env-shaped object that the legacy helpers can consume.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(opts.apiKey ? { CELIUMS_LLM_API_KEY: opts.apiKey } : {}),
    ...(opts.baseUrl ? { CELIUMS_LLM_BASE_URL: opts.baseUrl } : {}),
    ...(opts.defaultModel ? { CELIUMS_LLM_MODEL: opts.defaultModel } : {}),
    ...(opts.defaultEmbedModel ? { CELIUMS_EMBED_MODEL: opts.defaultEmbedModel } : {}),
  };

  return {
    providerId: 'openai-compat',
    name: 'OpenAI-compatible',

    async chat(req: ChatRequest): Promise<ChatResponse> {
      try {
        const content = await llmChat(
          // The legacy ChatMessage only carries system|user|assistant; map tool→assistant
          // so we don't lose the message (caller's responsibility to render correctly).
          req.messages.map((m) => ({
            role: m.role === 'tool' ? 'assistant' : m.role,
            content: m.content,
          })),
          {
            model: req.model || opts.defaultModel,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            timeoutMs: opts.timeoutMs,
          },
          env,
        );
        return {
          content,
          modelUsed: req.model || opts.defaultModel || 'unknown',
          // OpenAI-compat path doesn't surface usage in the legacy helper;
          // a future enhancement would parse /v1/chat/completions.usage.
        };
      } catch (err) {
        throw new ProviderRequestError(`openai-compat: chat failed — ${(err as Error).message}`, err);
      }
    },

    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      const texts = Array.isArray(req.input) ? req.input : [req.input];
      const vectors: number[][] = [];
      try {
        for (const text of texts) {
          const vec = await llmEmbed(
            text,
            { model: req.model || opts.defaultEmbedModel, timeoutMs: opts.timeoutMs },
            env,
          );
          vectors.push(vec);
        }
      } catch (err) {
        throw new ProviderRequestError(`openai-compat: embed failed — ${(err as Error).message}`, err);
      }
      return {
        embeddings: vectors,
        modelUsed: req.model || opts.defaultEmbedModel || 'unknown',
        dimensions: vectors[0]?.length,
      };
    },
  };
}
