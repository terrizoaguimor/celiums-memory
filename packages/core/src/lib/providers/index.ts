// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Provider factory + barrel.
 *
 * Public API:
 *   - `selectProvider(env)` reads CELIUMS_LLM_PROVIDER and returns the
 *     right LlmAdapter, ready to use.
 *   - `createProvider(id, opts)` builds an adapter for a specific id.
 *   - `Providers` enum-like object — list of known providerId strings.
 *   - Type re-exports for adapter consumers.
 *
 * Env vars consulted by `selectProvider`:
 *   CELIUMS_LLM_PROVIDER   one of Providers values (default 'openai-compat')
 *   CELIUMS_LLM_API_KEY    auth credential
 *   CELIUMS_LLM_BASE_URL   override base URL (mostly openai-compat / ollama)
 *   CELIUMS_LLM_MODEL      default chat model
 *   CELIUMS_EMBED_MODEL    default embed model
 *   CELIUMS_LLM_REGION     for bedrock / vertex
 *   CELIUMS_LLM_PROJECT    for vertex
 *
 * To add a new provider:
 *   1. Add it to the `Providers` map below.
 *   2. Handle it in `createProvider`.
 *   3. If it's LangChain-backed, just add the key to LangChainProviderKey
 *      and you're done — `via-langchain.ts` handles the rest.
 *   4. If it's manual, create lib/providers/<name>.ts with a
 *      `create<Name>Adapter(opts)` factory and dispatch here.
 */

import type { LlmAdapter, ProviderOpts } from './types.js';
import { createLangChainAdapter, type LangChainProviderKey } from './via-langchain.js';
import { createCohereAdapter } from './cohere.js';
import { createOllamaAdapter } from './ollama.js';
import { createOpenAICompatAdapter } from './openai-compat.js';

export * from './types.js';
export { createLangChainAdapter, type LangChainProviderKey } from './via-langchain.js';
export { createCohereAdapter } from './cohere.js';
export { createOllamaAdapter } from './ollama.js';
export { createOpenAICompatAdapter } from './openai-compat.js';

/**
 * Canonical providerId strings. Mirror these in docs and the
 * the web UI provider dropdown.
 */
export const Providers = {
  // OpenAI-compatible (DigitalOcean Inference, OpenAI direct, OpenRouter, Groq, Together,
  // vLLM, LM Studio, Ollama's /v1/ shim). DEFAULT.
  OpenAICompat: 'openai-compat' as const,
  // LangChain-backed (via the official @langchain/* provider packages).
  OpenAI:      'openAI'      as const,
  VertexAI:    'vertexai'    as const,
  Bedrock:     'bedrock'     as const,
  Anthropic:   'anthropic'   as const,
  MistralAI:   'mistralai'   as const,
  Mistral:     'mistral'     as const,
  Google:      'google'      as const,
  AzureOpenAI: 'azureOpenAI' as const,
  DeepSeek:    'deepseek'    as const,
  OpenRouter:  'openrouter'  as const,
  XAI:         'xai'         as const,
  Moonshot:    'moonshot'    as const,
  // Manual adapters.
  Cohere:      'cohere'      as const,
  Ollama:      'ollama'      as const,
} as const;

export type ProviderId = typeof Providers[keyof typeof Providers];

/** True if the given string is a recognised providerId. */
export function isProviderId(s: string): s is ProviderId {
  return Object.values(Providers).includes(s as ProviderId);
}

/** Known LangChain-backed keys (subset of ProviderId). */
const LANGCHAIN_KEYS = new Set<string>([
  Providers.OpenAI,
  Providers.VertexAI,
  Providers.Bedrock,
  Providers.Anthropic,
  Providers.MistralAI,
  Providers.Mistral,
  Providers.Google,
  Providers.AzureOpenAI,
  Providers.DeepSeek,
  Providers.OpenRouter,
  Providers.XAI,
  Providers.Moonshot,
]);

/**
 * Build an adapter for the given providerId. Throws if the id is unknown.
 */
export function createProvider(id: ProviderId, opts: ProviderOpts = {}): LlmAdapter {
  if (LANGCHAIN_KEYS.has(id)) {
    return createLangChainAdapter(id as LangChainProviderKey, {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      defaultModel: opts.defaultModel,
      region: opts.region,
      projectId: opts.projectId,
      extra: opts.extra,
    });
  }
  switch (id) {
    case Providers.OpenAICompat:
      return createOpenAICompatAdapter({
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        defaultModel: opts.defaultModel,
        defaultEmbedModel: (opts.extra?.['defaultEmbedModel'] as string | undefined),
      });
    case Providers.Cohere:
      return createCohereAdapter({
        apiKey: opts.apiKey,
        defaultModel: opts.defaultModel,
        defaultEmbedModel: (opts.extra?.['defaultEmbedModel'] as string | undefined),
      });
    case Providers.Ollama:
      return createOllamaAdapter({
        baseUrl: opts.baseUrl,
        defaultModel: opts.defaultModel,
        defaultEmbedModel: (opts.extra?.['defaultEmbedModel'] as string | undefined),
      });
    default: {
      // Exhaustiveness check — TS will yell if a new Providers value isn't handled.
      const _exhaustive: never = id as never;
      throw new Error(`Unknown providerId: ${_exhaustive}`);
    }
  }
}

/**
 * Read env and pick the right provider. Returns a ready-to-use adapter.
 *
 * Fallback chain:
 *   1. CELIUMS_LLM_PROVIDER set → use it
 *   2. CELIUMS_LLM_API_KEY set without provider → 'openai-compat'
 *   3. neither set → throws (caller must wire a provider explicitly)
 */
export function selectProvider(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  const explicit = env['CELIUMS_LLM_PROVIDER'];
  const id: ProviderId = explicit && isProviderId(explicit)
    ? explicit
    : Providers.OpenAICompat;

  if (!explicit && !env['CELIUMS_LLM_API_KEY'] && id === Providers.OpenAICompat) {
    throw new Error(
      'No LLM provider configured. Set CELIUMS_LLM_PROVIDER + CELIUMS_LLM_API_KEY (and CELIUMS_LLM_BASE_URL for self-hosted).',
    );
  }

  return createProvider(id, {
    apiKey: env['CELIUMS_LLM_API_KEY'],
    baseUrl: env['CELIUMS_LLM_BASE_URL'],
    defaultModel: env['CELIUMS_LLM_MODEL'],
    region: env['CELIUMS_LLM_REGION'],
    projectId: env['CELIUMS_LLM_PROJECT'],
    extra: {
      defaultEmbedModel: env['CELIUMS_EMBED_MODEL'],
    },
  });
}
