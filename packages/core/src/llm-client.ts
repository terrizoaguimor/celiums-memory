/**
 * Generic OpenAI-compatible LLM client — BYOK (bring your own key).
 *
 * The OSS engine never talks to a proprietary endpoint. Tools that need
 * a model use this client, which is configured purely from env vars:
 *
 *   CELIUMS_LLM_BASE_URL   default 'https://api.openai.com/v1'
 *   CELIUMS_LLM_API_KEY    required for any tool that calls the model
 *   CELIUMS_LLM_MODEL      default 'gpt-4o-mini'
 *   CELIUMS_EMBED_MODEL    default 'text-embedding-3-small'
 *
 * Works with any OpenAI-compatible service. See `llm-providers.ts` for the
 * curated list (DigitalOcean Inference, OpenAI, Anthropic, OpenRouter, Groq,
 * Together, Ollama, LM Studio, vLLM). Examples:
 *
 *   # DigitalOcean Inference (Anthropic + OpenAI + Llama + DeepSeek + more, one key)
 *   export CELIUMS_LLM_BASE_URL=https://inference.do-ai.run/v1
 *   export CELIUMS_LLM_API_KEY=sk-do-...
 *   export CELIUMS_LLM_MODEL=anthropic-claude-haiku-4.5
 *
 *   # OpenAI (default)
 *   export CELIUMS_LLM_API_KEY=sk-...
 *
 *   # Ollama (local, free)
 *   export CELIUMS_LLM_BASE_URL=http://localhost:11434/v1
 *   export CELIUMS_LLM_API_KEY=ollama
 *   export CELIUMS_LLM_MODEL=llama3.2
 *
 *   # OpenRouter (any model, one key)
 *   export CELIUMS_LLM_BASE_URL=https://openrouter.ai/api/v1
 *   export CELIUMS_LLM_API_KEY=sk-or-...
 *   export CELIUMS_LLM_MODEL=anthropic/claude-3.5-sonnet
 *
 *   # Together / Groq / vLLM / LM Studio / etc — same pattern
 *
 * The client is intentionally tiny (~100 lines). For complex workflows
 * (streaming, tool calling, structured outputs) bring your own SDK and
 * call this only when the inline tools need a quick completion.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface EmbedOptions {
  model?: string;
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
}

interface EmbedResponse {
  data?: Array<{ embedding?: number[] }>;
  model?: string;
}

/** True if a model API key is configured. Tools should gate themselves on this. */
export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['CELIUMS_LLM_API_KEY']);
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  return (env['CELIUMS_LLM_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function defaultModel(env: NodeJS.ProcessEnv): string {
  return env['CELIUMS_LLM_MODEL'] ?? DEFAULT_MODEL;
}

function defaultEmbedModel(env: NodeJS.ProcessEnv): string {
  return env['CELIUMS_EMBED_MODEL'] ?? DEFAULT_EMBED_MODEL;
}

function authHeader(env: NodeJS.ProcessEnv): Record<string, string> {
  const key = env['CELIUMS_LLM_API_KEY'];
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Single-turn or multi-turn chat completion via OpenAI-compatible /chat/completions.
 * Returns the assistant message content as a string. Throws on any failure.
 */
export async function llmChat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!llmConfigured(env)) {
    throw new Error(
      'CELIUMS_LLM_API_KEY is not set. Configure an OpenAI-compatible endpoint to use LLM-backed tools.',
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: opts.model ?? defaultModel(env),
      messages,
    };
    if (opts.temperature !== undefined) body['temperature'] = opts.temperature;
    if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens;

    const res = await fetch(`${baseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(env) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as ChatResponse;
    return json.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embedding via OpenAI-compatible /embeddings.
 * Returns a single vector for a single text. Throws on any failure.
 */
export async function llmEmbed(
  text: string,
  opts: EmbedOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<number[]> {
  if (!llmConfigured(env)) {
    throw new Error(
      'CELIUMS_LLM_API_KEY is not set. Configure an OpenAI-compatible endpoint to use embeddings.',
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl(env)}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(env) },
      body: JSON.stringify({
        model: opts.model ?? defaultEmbedModel(env),
        input: text,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Embed ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as EmbedResponse;
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('Embed response missing data[0].embedding');
    return vec;
  } finally {
    clearTimeout(timer);
  }
}
