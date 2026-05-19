// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * LlmAdapter — unified interface that every provider implementation
 * exposes to the Celiums Memory library.
 *
 * The @celiums/memory library has 15+ provider adapters: LangChain-backed
 * (12 via the official @langchain/* provider packages) plus three manual
 * ones (Cohere, Ollama, OpenAI-compat).
 *
 * Adapters are intentionally minimal: chat + embeddings + streaming.
 * Agent orchestration (LangGraph, tool calling, multi-step) is a
 * concern OF THE CALLER, not of the adapter — this library only
 * abstracts the per-provider chat-completion call.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Optional name (for tool messages or named agents). */
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Provider-specific model id (e.g. 'claude-3-5-sonnet-20241022'). */
  model: string;
  /** 0..2 typically. Defaults are provider-specific. */
  temperature?: number;
  /** Max tokens in the response. */
  maxTokens?: number;
  /** Top-p sampling. */
  topP?: number;
  /** Stop sequences. */
  stop?: string[];
  /** When true the adapter returns a streaming async iterable instead of a single ChatResponse. */
  stream?: boolean;
}

export interface ChatResponse {
  /** Final assistant message. */
  content: string;
  /** Provider's reported model (may differ from requested when routing). */
  modelUsed: string;
  /** Token usage if reported. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** Finish reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string. */
  finishReason?: string;
}

export interface EmbedRequest {
  /** One or many inputs. Adapters that don't support batching loop. */
  input: string | string[];
  /** Provider-specific embedding model id. */
  model?: string;
}

export interface EmbedResponse {
  /** Vector(s) — order matches input. */
  embeddings: number[][];
  modelUsed: string;
  /** Dimension count (informational). */
  dimensions?: number;
}

/** Streaming chunk shape. Adapters yield these in order. */
export interface ChatStreamChunk {
  delta: string;
  finishReason?: string;
  usage?: ChatResponse['usage'];
}

/** Common contract every adapter implements. */
export interface LlmAdapter {
  /** Stable provider identifier — matches the env CELIUMS_LLM_PROVIDER. */
  readonly providerId: string;
  /** Human-readable name for surfaces like the dashboard. */
  readonly name: string;
  /** Non-streaming chat completion. */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Optional embeddings (some providers don't support them). */
  embed?: (req: EmbedRequest) => Promise<EmbedResponse>;
  /** Optional streaming chat. Yields ChatStreamChunk in order. */
  stream?: (req: ChatRequest) => AsyncIterable<ChatStreamChunk>;
}

/** Options passed to factory `createProvider(opts)`. */
export interface ProviderOpts {
  /** API key for the provider. */
  apiKey?: string;
  /** Override base URL (used heavily by openai-compat). */
  baseUrl?: string;
  /** Optional default model when ChatRequest.model is not specified. */
  defaultModel?: string;
  /** Optional region (Bedrock, Vertex AI). */
  region?: string;
  /** Optional project id (Vertex AI, Google Cloud). */
  projectId?: string;
  /** Free-form extra config — provider-specific. */
  extra?: Record<string, unknown>;
}

/** Thrown when the requested provider is not installed/available. */
export class ProviderUnavailable extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  constructor(providerId: string, reason: string) {
    super(`Provider "${providerId}" unavailable: ${reason}`);
    this.name = 'ProviderUnavailable';
  }
}

/** Thrown when the adapter receives an input that can't be served. */
export class ProviderRequestError extends Error {
  readonly code = 'PROVIDER_REQUEST_ERROR' as const;
  constructor(message: string, public readonly upstream?: unknown) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}
