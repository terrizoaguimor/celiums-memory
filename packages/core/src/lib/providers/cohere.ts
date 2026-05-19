// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Cohere adapter — uses cohere-ai SDK direct.
 *
 * The @langchain/* providers don't cover Cohere, so we wire it manually.
 * Cohere has a strong embeddings story (Rerank, Embed) so we expose
 * both chat and embeddings.
 */

import type { LlmAdapter, ChatRequest, ChatResponse, EmbedRequest, EmbedResponse } from './types.js';
import { ProviderUnavailable, ProviderRequestError } from './types.js';

export function createCohereAdapter(opts: {
  apiKey?: string;
  defaultModel?: string;
  defaultEmbedModel?: string;
}): LlmAdapter {
  return {
    providerId: 'cohere',
    name: 'Cohere',

    async chat(req: ChatRequest): Promise<ChatResponse> {
      let mod: any;
      try {
        mod = await import('cohere-ai');
      } catch (err) {
        throw new ProviderUnavailable('cohere', 'cohere-ai SDK not installed');
      }
      const { CohereClient } = mod;
      if (!CohereClient) {
        throw new ProviderUnavailable('cohere', 'cohere-ai SDK shape changed — CohereClient export missing');
      }
      const client = new CohereClient({ token: opts.apiKey ?? '' });

      const model = req.model || opts.defaultModel || 'command-r-plus';
      const system = req.messages.find((m) => m.role === 'system')?.content;
      const history = req.messages
        .filter((m) => m.role !== 'system')
        .slice(0, -1)
        .map((m) => ({
          role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
          message: m.content,
        }));
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) {
        throw new ProviderRequestError('cohere: at least one user message is required');
      }

      let resp: any;
      try {
        resp = await client.chat({
          model,
          message: lastUser.content,
          chatHistory: history.length > 0 ? history : undefined,
          preamble: system,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          p: req.topP,
          stopSequences: req.stop,
        });
      } catch (err) {
        throw new ProviderRequestError(`cohere: chat failed — ${(err as Error).message}`, err);
      }

      return {
        content: resp.text ?? '',
        modelUsed: model,
        usage: resp.meta?.tokens ? {
          promptTokens: resp.meta.tokens.inputTokens,
          completionTokens: resp.meta.tokens.outputTokens,
          totalTokens: (resp.meta.tokens.inputTokens ?? 0) + (resp.meta.tokens.outputTokens ?? 0),
        } : undefined,
        finishReason: resp.finishReason,
      };
    },

    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      let mod: any;
      try {
        mod = await import('cohere-ai');
      } catch (err) {
        throw new ProviderUnavailable('cohere', 'cohere-ai SDK not installed');
      }
      const { CohereClient } = mod;
      const client = new CohereClient({ token: opts.apiKey ?? '' });

      const model = req.model || opts.defaultEmbedModel || 'embed-english-v3.0';
      const texts = Array.isArray(req.input) ? req.input : [req.input];

      let resp: any;
      try {
        resp = await client.embed({
          texts,
          model,
          inputType: 'search_document',
        });
      } catch (err) {
        throw new ProviderRequestError(`cohere: embed failed — ${(err as Error).message}`, err);
      }

      const vectors: number[][] = resp.embeddings?.float ?? resp.embeddings ?? [];
      return {
        embeddings: vectors,
        modelUsed: model,
        dimensions: vectors[0]?.length,
      };
    },
  };
}
