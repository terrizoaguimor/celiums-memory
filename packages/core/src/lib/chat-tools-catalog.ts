// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Tool catalog exposed to the chat agent (OpenAI-compatible function
 * calling schema).
 *
 * Cada tool envuelve un MCP tool del backend. Cuando el modelo invoca
 * uno de estos, el chat-runner lo despacha via `dispatchMcp` con el
 * agent_id del modelo correctamente scoped.
 *
 * Filosofía:
 *   - `memory_*` opera sobre las memorias del USUARIO.
 *   - `journal_*` opera sobre el journal del MODELO actual (excepto
 *     cuando explicit `inherit_from` lee otro modelo).
 *   - `forage` / `atlas_ask` / `ethics_lookup` son search/recommend
 *     tools que no mutan estado.
 *
 * Solo open-source friendly. No exponemos tools que requieran
 * comunicarse con servicios closed-weight.
 */

export interface ToolFunctionDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const CELIUMS_CHAT_TOOLS: ToolFunctionDef[] = [
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description:
        'Search the USER memory store semantically. Use when you need to look up something specific about the user (preferences, decisions, facts) beyond what the system prompt already gave you.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query.',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 5, max 20).',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tag filter.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_remember',
      description:
        'Persist a NEW memory about the user. Use ONLY for genuinely important info that should survive across conversations and models: decisions, preferences, facts about the user, relationships, ongoing projects. Do NOT use for ephemeral chat content.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The memory content. Write it as a third-person fact.',
          },
          memory_type: {
            type: 'string',
            enum: ['observation', 'preference', 'fact', 'decision', 'experience', 'skill'],
          },
          importance: {
            type: 'number',
            description: '0..1 — your estimate of how important this is to retain.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['content', 'memory_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'journal_write',
      description:
        'Append an entry to YOUR (this model\'s) journal. Use for decisions, lessons, reflections, or doubts you want auditable later. Each model has its own journal — your entries are scoped to you.',
      parameters: {
        type: 'object',
        properties: {
          entry_type: {
            type: 'string',
            enum: ['decision', 'reflection', 'lesson', 'belief', 'arc', 'doubt', 'emotion'],
          },
          content: {
            type: 'string',
            description: 'First-person reflection. Write as YOU.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          valence: {
            type: 'number',
            description: '-1..+1 emotional valence (optional).',
          },
        },
        required: ['entry_type', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'journal_recall',
      description:
        'Search YOUR journal (or another model\'s journal if you pass `inherit_from`). Useful when you want to remember how YOU solved something similar before, or to see what a predecessor model decided.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          inherit_from: {
            type: 'string',
            description: 'agent_id of another model whose journal you want to read (e.g. "llama-3.3-70b", "qwen-3.5-397b").',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atlas_ask',
      description:
        'Get a second opinion from a different-tier model on a hard question. Use sparingly — only when your own reasoning seems uncertain or when explicit cross-check is requested.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question for the second-opinion model.',
          },
          tier: {
            type: 'string',
            enum: ['T1', 'T2', 'T3', 'T4', 'T5'],
            description: 'Tier hint — higher = more expensive + more capable.',
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ethics_lookup',
      description:
        'Query the Celiums ethics knowledge base for guidance on edge cases (privacy, consent, sensitive content). Returns relevant principles + precedents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forage',
      description:
        'Search the Celiums knowledge corpus (500K+ expert modules) by natural-language query. Use when the user needs technical guidance, best practices, or domain expertise NOT covered by their personal memories. Returns ranked module names + descriptions; pair with `synthesize` to apply one.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Specific query. Examples: "kubernetes horizontal pod autoscaler", "react server components patterns".',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 10, max 50). Lower for focus, higher for exploration.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'map_network',
      description:
        'Browse the Celiums knowledge network by category. Returns the full map (all categories, module counts, top modules per category). No parameters needed. Use to discover what knowledge is available before drilling in with `forage`.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atlas_recommend',
      description:
        'Ask Atlas for a ranked list of recommended LLM models with per-1K token cost estimates for a given task. Use when you want to suggest a cheaper/different model for a sub-task, or when explicit cost/quality reasoning is requested.',
      parameters: {
        type: 'object',
        properties: {
          task_description: {
            type: 'string',
            description: 'Natural-language description of the task you want a model for.',
          },
        },
        required: ['task_description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decompose',
      description:
        'Break complex content into structured, reusable knowledge: outline, taxonomy, checklist, Q&A, or decision tree. Use when the user has a dense block of text/spec/transcript and wants it organized.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The content to decompose.',
          },
          structure: {
            type: 'string',
            enum: ['auto', 'outline', 'taxonomy', 'checklist', 'qa', 'decision_tree'],
            description: 'Output structure. Default "auto".',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'synthesize',
      description:
        'Apply a knowledge module to solve a specific task. Loads the module content and combines it with AI reasoning to produce a concrete solution. Typical flow: `forage(query)` → pick a module → `synthesize(module, task)`.',
      parameters: {
        type: 'object',
        properties: {
          module: {
            type: 'string',
            description: 'Module name/slug returned by forage or map_network.',
          },
          task: {
            type: 'string',
            description: 'The specific task or problem to solve using the module knowledge.',
          },
        },
        required: ['module', 'task'],
      },
    },
  },
];

/**
 * Map our `tool name → MCP tool name`. Most are identity, but we keep
 * the indirection in case we want to surface different names to the
 * agent than what the MCP dispatcher registers.
 */
export const TOOL_TO_MCP: Record<string, string> = {
  memory_recall: 'recall',
  memory_remember: 'remember',
  journal_write: 'journal_write',
  journal_recall: 'journal_recall',
  atlas_ask: 'atlas_ask',
  ethics_lookup: 'ethics_lookup',
  forage: 'forage',
  map_network: 'map_network',
  atlas_recommend: 'atlas_recommend',
  decompose: 'decompose',
  synthesize: 'synthesize',
};
