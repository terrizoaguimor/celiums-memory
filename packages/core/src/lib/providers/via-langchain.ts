// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * via-langchain — adapter over the official @langchain/* provider
 * packages, imported directly (one lazy import per provider).
 *
 * Covers 12 providers turnkey:
 *   OpenAI, Azure OpenAI, OpenRouter, Moonshot (Kimi) — all OpenAI-compat
 *   via @langchain/openai; Anthropic; Mistral AI; Google Gemini; Google
 *   Vertex AI; AWS Bedrock; DeepSeek; xAI (Grok).
 *
 * We deliberately do NOT depend on @librechat/agents here: it pulls
 * @langchain/langgraph → langgraph-sdk → svelte (plus LangSmith), a
 * transitive chain this engine never executes but that drags a stack
 * of advisories and dead UI weight. Importing each provider package
 * directly keeps the dependency surface to exactly what we use.
 *
 * Each call constructs a LangChain ChatModel and invokes
 * `.invoke(messages)`. No LangGraph orchestration — single-completion
 * shape only.
 */

import type {
  LlmAdapter, ChatRequest, ChatResponse,
} from './types.js';
import { ProviderUnavailable, ProviderRequestError } from './types.js';

/** Provider keys we expose. Stable string values (kept identical to the
 *  previous enum so callers and stored configs don't change). */
export type LangChainProviderKey =
  | 'openAI'        // OpenAI direct
  | 'vertexai'      // Google Vertex AI
  | 'bedrock'       // AWS Bedrock
  | 'anthropic'     // Anthropic raw API
  | 'mistralai'     // Mistral AI (newer enum)
  | 'mistral'       // Mistral AI (older enum, still supported)
  | 'google'        // Google Gemini direct (Generative AI API)
  | 'azureOpenAI'   // Azure OpenAI
  | 'deepseek'      // DeepSeek raw
  | 'openrouter'    // OpenRouter (OpenAI-compat)
  | 'xai'           // xAI (Grok)
  | 'moonshot';     // Moonshot (Kimi, OpenAI-compat)

/** provider → which @langchain/* package + exported class to construct.
 *  baseUrl is a sane default for the OpenAI-compat aggregators; an
 *  explicit opts.baseUrl always wins. */
const PROVIDER_MODULE: Record<
  LangChainProviderKey,
  { pkg: string; cls: string; baseUrl?: string }
> = {
  openAI:      { pkg: '@langchain/openai',          cls: 'ChatOpenAI' },
  azureOpenAI: { pkg: '@langchain/openai',          cls: 'AzureChatOpenAI' },
  openrouter:  { pkg: '@langchain/openai',          cls: 'ChatOpenAI', baseUrl: 'https://openrouter.ai/api/v1' },
  moonshot:    { pkg: '@langchain/openai',          cls: 'ChatOpenAI', baseUrl: 'https://api.moonshot.ai/v1' },
  anthropic:   { pkg: '@langchain/anthropic',       cls: 'ChatAnthropic' },
  mistralai:   { pkg: '@langchain/mistralai',       cls: 'ChatMistralAI' },
  mistral:     { pkg: '@langchain/mistralai',       cls: 'ChatMistralAI' },
  google:      { pkg: '@langchain/google-genai',    cls: 'ChatGoogleGenerativeAI' },
  vertexai:    { pkg: '@langchain/google-vertexai', cls: 'ChatVertexAI' },
  bedrock:     { pkg: '@langchain/aws',             cls: 'ChatBedrockConverse' },
  deepseek:    { pkg: '@langchain/deepseek',        cls: 'ChatDeepSeek' },
  xai:         { pkg: '@langchain/xai',             cls: 'ChatXAI' },
};

function rolesToLangChainMessages(messages: ChatRequest['messages']): Array<{ role: string; content: string }> {
  // LangChain's BaseChatModel.invoke accepts an array of {role, content}.
  // Tool messages get role='function' in some providers; we keep the raw
  // role and let the provider handle the dialect.
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export function createLangChainAdapter(provider: LangChainProviderKey, opts: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  region?: string;
  projectId?: string;
  extra?: Record<string, unknown>;
}): LlmAdapter {
  return {
    providerId: provider,
    name: providerDisplayName(provider),
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const spec = PROVIDER_MODULE[provider];
      if (!spec) {
        throw new ProviderUnavailable(provider, `unknown provider '${provider}'`);
      }

      // Lazy-import the specific provider package so cold-start stays
      // low when only one provider (or the OpenAI-compat path) is used.
      let mod: any;
      try {
        mod = await import(spec.pkg);
      } catch (err) {
        throw new ProviderUnavailable(
          provider,
          `${spec.pkg} not installed — run pnpm install in packages/core`,
        );
      }
      const Ctor: any = mod[spec.cls] ?? mod.default?.[spec.cls];
      if (typeof Ctor !== 'function') {
        throw new ProviderUnavailable(
          provider,
          `${spec.pkg} does not export ${spec.cls}`,
        );
      }

      // Build provider config. Each ChatModel constructor takes a
      // ProviderOptions object — we pass the union of our known fields
      // and let the underlying class ignore what it doesn't use.
      const model = req.model || opts.defaultModel;
      if (!model) {
        throw new ProviderRequestError(`${provider}: ChatRequest.model required (no defaultModel set)`);
      }
      const effBaseUrl = opts.baseUrl ?? spec.baseUrl;
      const providerConfig: Record<string, unknown> = {
        model,
        apiKey: opts.apiKey,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        topP: req.topP,
        stop: req.stop,
        ...(effBaseUrl ? { configuration: { baseURL: effBaseUrl } } : {}),
        ...(opts.region ? { region: opts.region } : {}),
        ...(opts.projectId ? { project: opts.projectId } : {}),
        ...(opts.extra ?? {}),
      };

      let chat: any;
      try {
        chat = new Ctor(providerConfig);
      } catch (err) {
        throw new ProviderRequestError(`${provider}: failed to construct ChatModel — ${(err as Error).message}`, err);
      }

      let result: any;
      try {
        result = await chat.invoke(rolesToLangChainMessages(req.messages));
      } catch (err) {
        throw new ProviderRequestError(`${provider}: invoke failed — ${(err as Error).message}`, err);
      }

      // LangChain BaseMessage shape: { content, response_metadata?, usage_metadata? }
      const content = typeof result?.content === 'string'
        ? result.content
        : Array.isArray(result?.content)
          ? result.content.map((p: any) => p.text ?? '').join('')
          : '';

      const usage = result?.usage_metadata ?? result?.response_metadata?.tokenUsage ?? undefined;
      const finishReason = result?.response_metadata?.finish_reason ?? result?.response_metadata?.stop_reason ?? undefined;

      return {
        content,
        modelUsed: result?.response_metadata?.model ?? model,
        usage: usage ? {
          promptTokens: usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens,
          completionTokens: usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens,
          totalTokens: usage.total_tokens ?? usage.totalTokens,
        } : undefined,
        finishReason,
      };
    },
  };
}

function providerDisplayName(p: LangChainProviderKey): string {
  switch (p) {
    case 'openAI':      return 'OpenAI';
    case 'vertexai':    return 'Google Vertex AI';
    case 'bedrock':     return 'AWS Bedrock';
    case 'anthropic':   return 'Anthropic';
    case 'mistralai':
    case 'mistral':     return 'Mistral AI';
    case 'google':      return 'Google Gemini';
    case 'azureOpenAI': return 'Azure OpenAI';
    case 'deepseek':    return 'DeepSeek';
    case 'openrouter':  return 'OpenRouter';
    case 'xai':         return 'xAI (Grok)';
    case 'moonshot':    return 'Moonshot (Kimi)';
  }
}
