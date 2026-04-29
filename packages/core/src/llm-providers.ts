/**
 * Known LLM provider presets — for BYOK.
 *
 * The OSS engine never talks to a proprietary endpoint by itself. The user
 * brings a key for an OpenAI-compatible service. This file is metadata only:
 * names, default endpoints, default models, and a curated model list per
 * provider. The dashboard renders these as a dropdown so users do not have
 * to memorize URLs or model IDs.
 *
 * Add a new provider by appending an entry. All providers must speak OpenAI's
 * `/chat/completions` and `/embeddings` HTTP shapes.
 */

export type LlmProviderId =
  | 'openai'
  | 'anthropic'
  | 'do-inference'
  | 'openrouter'
  | 'groq'
  | 'together'
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'custom';

export interface LlmProviderModel {
  id: string;
  label: string;
  /** Use case hint shown next to the model in dashboard dropdowns. */
  hint?: string;
}

export interface LlmProvider {
  id: LlmProviderId;
  name: string;
  /** One-line description shown in the dashboard. */
  description: string;
  /** Default base URL. User can override via env or dashboard. */
  baseUrl: string;
  /** Where to get an API key (link surfaced in dashboard). */
  signupUrl?: string;
  /** Default chat model id for this provider. */
  defaultModel: string;
  /** Default embedding model id (if the provider exposes one). */
  defaultEmbedModel?: string;
  /** Curated list of recommended chat models. Not exhaustive. */
  models: LlmProviderModel[];
  /** Whether the provider also serves OpenAI-compatible /embeddings. */
  supportsEmbeddings: boolean;
  /** True if the provider runs locally (no key needed). */
  local: boolean;
}

export const PROVIDERS: LlmProvider[] = [
  {
    id: 'do-inference',
    name: 'DigitalOcean Gradient (Inference)',
    description:
      'Frontier and open-weight models on DigitalOcean Gradient AI Platform. One Model Access Key (the new "doo_v1_..." format, or legacy "sk-do-...") works across Anthropic, OpenAI, Llama, DeepSeek, Qwen, Kimi, Nemotron, MiniMax, Gemma, and more — no per-vendor signup.',
    // OpenAI-compatible base. Auth: `Authorization: Bearer <DO model access key>`.
    // Verified live 2026-04-29 via GET /v1/models (returned 55 models).
    baseUrl: 'https://inference.do-ai.run/v1',
    signupUrl: 'https://cloud.digitalocean.com/gradient/inference/access-keys',
    defaultModel: 'anthropic-claude-haiku-4.5',
    defaultEmbedModel: 'gte-large-en-v1.5',
    supportsEmbeddings: true,
    local: false,
    // Curated highlights only — the dashboard's auto-probe pulls the full
    // live list (55+ models as of 2026-04-29) directly from /v1/models
    // when the user pastes their key.
    models: [
      { id: 'anthropic-claude-opus-4.7', label: 'Claude Opus 4.7', hint: 'Highest quality, 1M context' },
      { id: 'anthropic-claude-4.6-sonnet', label: 'Claude Sonnet 4.6', hint: 'Daily premium workhorse, 1M context' },
      { id: 'anthropic-claude-haiku-4.5', label: 'Claude Haiku 4.5', hint: 'Fast, cheap, capable' },
      { id: 'openai-gpt-5.5', label: 'GPT 5.5', hint: 'OpenAI flagship' },
      { id: 'openai-gpt-5.4', label: 'GPT 5.4', hint: 'OpenAI tier-2, 1M context' },
      { id: 'openai-gpt-5.4-mini', label: 'GPT 5.4-mini', hint: 'Fast OpenAI tier' },
      { id: 'openai-gpt-5.3-codex', label: 'GPT 5.3 codex', hint: 'Code-tuned, 400k context' },
      { id: 'kimi-k2.5', label: 'Kimi K2.5', hint: 'Long-context flagship' },
      { id: 'glm-5', label: 'GLM 5', hint: 'Creative / multimodal' },
      { id: 'minimax-m2.5', label: 'MiniMax M2.5', hint: 'Strong reasoning' },
      { id: 'deepseek-3.2', label: 'DeepSeek 3.2', hint: 'Strong reasoning at low cost' },
      { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek-R1 distill 70B', hint: 'Cheap reasoning chains' },
      { id: 'llama-4-maverick', label: 'Llama 4 Maverick', hint: 'Open-weight workhorse' },
      { id: 'llama3.3-70b-instruct', label: 'Llama 3.3 70B', hint: 'Agents / classification' },
      { id: 'qwen3.5-397b-a17b', label: 'Qwen 3.5 397B', hint: 'Open-weight large MoE' },
      { id: 'qwen3-coder-flash', label: 'Qwen 3 Coder Flash', hint: 'Fast code generation' },
      { id: 'nvidia-nemotron-3-super-120b', label: 'Nemotron 3 Super 120B', hint: 'Bulk generation alt' },
      { id: 'arcee-trinity-large-thinking', label: 'Arcee Trinity (thinking)', hint: 'Reasoning-tuned' },
      { id: 'gemma-4-31B-it', label: 'Gemma 4 31B', hint: 'Open-weight, light' },
      { id: 'mistral-3-14B', label: 'Mistral 3 14B', hint: 'Open-weight efficient' },
    ],
  },

  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Native OpenAI API with GPT models and text-embedding-3 family.',
    baseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o-mini',
    defaultEmbedModel: 'text-embedding-3-small',
    supportsEmbeddings: true,
    local: false,
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', hint: 'Flagship' },
      { id: 'gpt-4o-mini', label: 'GPT-4o-mini', hint: 'Fast and cheap' },
      { id: 'o1', label: 'o1', hint: 'Reasoning' },
      { id: 'o3-mini', label: 'o3-mini', hint: 'Reasoning, fast' },
    ],
  },

  {
    id: 'anthropic',
    name: 'Anthropic (via OpenAI-compatible proxy)',
    description:
      'Anthropic does not natively expose /chat/completions. Use a proxy like Anthropic Bridge or use DO Inference / OpenRouter for OpenAI-style access.',
    baseUrl: 'https://api.anthropic.com/v1',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-4',
    supportsEmbeddings: false,
    local: false,
    models: [
      { id: 'claude-opus-4', label: 'Claude Opus 4' },
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },

  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One key, hundreds of models from every major lab.',
    baseUrl: 'https://openrouter.ai/api/v1',
    signupUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    supportsEmbeddings: false,
    local: false,
    models: [
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o-mini' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    ],
  },

  {
    id: 'groq',
    name: 'Groq',
    description: 'Sub-second open-weight inference via custom LPU silicon.',
    baseUrl: 'https://api.groq.com/openai/v1',
    signupUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsEmbeddings: false,
    local: false,
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', hint: 'Fastest tokens/sec' },
      { id: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B' },
    ],
  },

  {
    id: 'together',
    name: 'Together AI',
    description: 'Curated open-weight models, OpenAI-compatible.',
    baseUrl: 'https://api.together.xyz/v1',
    signupUrl: 'https://api.together.xyz/settings/api-keys',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    defaultEmbedModel: 'BAAI/bge-large-en-v1.5',
    supportsEmbeddings: true,
    local: false,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
      { id: 'mistralai/Mistral-Small-24B-Instruct-2501', label: 'Mistral Small 24B' },
    ],
  },

  {
    id: 'ollama',
    name: 'Ollama (local)',
    description: 'Runs models on your own machine. Zero cloud, zero cost, zero key required.',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    defaultEmbedModel: 'nomic-embed-text',
    supportsEmbeddings: true,
    local: true,
    models: [
      { id: 'llama3.2', label: 'Llama 3.2', hint: 'Fast local default' },
      { id: 'qwen2.5', label: 'Qwen 2.5' },
      { id: 'mistral', label: 'Mistral' },
    ],
  },

  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    description: 'Local desktop app exposing OpenAI-compatible server on 1234.',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    supportsEmbeddings: false,
    local: true,
    models: [{ id: 'local-model', label: 'Whatever LM Studio is serving' }],
  },

  {
    id: 'vllm',
    name: 'vLLM (self-hosted)',
    description: 'High-throughput open-source inference server you self-host.',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    supportsEmbeddings: false,
    local: true,
    models: [
      { id: 'meta-llama/Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B' },
    ],
  },

  {
    id: 'custom',
    name: 'Custom OpenAI-compatible endpoint',
    description: 'Any service that speaks OpenAI /chat/completions. You provide URL, key, and model id.',
    baseUrl: '',
    defaultModel: '',
    supportsEmbeddings: false,
    local: false,
    models: [],
  },
];

/** Look up a provider by id. */
export function getProvider(id: LlmProviderId): LlmProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Provider currently selected in the env. Falls back to inference of base URL. */
export function detectProvider(
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider | undefined {
  const explicit = env['CELIUMS_LLM_PROVIDER'] as LlmProviderId | undefined;
  if (explicit) return getProvider(explicit);

  const url = env['CELIUMS_LLM_BASE_URL'];
  if (!url) return getProvider('openai');
  const match = PROVIDERS.find((p) => p.baseUrl && url.startsWith(p.baseUrl));
  return match ?? getProvider('custom');
}
