/**
 * Intent classifier — turn a free-form user query (e.g. from a Notion
 * "@celiums <natural language>" trigger or a chat message) into a
 * concrete MCP tool call by asking an LLM to choose the best tool from
 * the known list and rewrite the args to match the tool's schema.
 *
 * Returns `{ tool, args }` ready to feed into the MCP dispatcher.
 *
 * On any failure (no LLM key, network error, malformed JSON, unknown
 * tool name) it falls back to `{ tool: 'recall', args: { query, userId } }`
 * — the safest default. Callers should still check `tool` against their
 * own whitelist before dispatching.
 *
 * The classifier is opt-in. If the user has not set CELIUMS_LLM_API_KEY,
 * `classifyIntent` returns the recall fallback immediately without making
 * a network call. This keeps the OSS engine usable without any LLM at
 * all — recall over the local store always works.
 */

import { llmChat, llmConfigured } from '../llm-client.js';

const TIMEOUT_MS = 15_000;

const SYSTEM = [
  'You are an intent classifier for Celiums Memory MCP tools. Given a user request, pick the single best tool and rewrite the request as the tool args.',
  '',
  'TOOLS:',
  '- recall: search the user\'s personal memory for past decisions, notes, learnings, conversations. Best for "what did I decide / what do I remember / qué dije sobre / cuándo …".',
  '- forage: semantic search over a public knowledge index. Best for "how does X work / qué es / patrones / explícame …".',
  '- synthesize: produce a synthesized narrative from memory. Best for "resume / summarize / qué aprendí esta semana / consolidar".',
  '- map_network: render a conceptual map / mind-map of memory clusters. Best for "mapea / cómo se conectan / network of …".',
  '- bloom: expand a single concept into related ideas (concept blooming). Best for "explora / variaciones de / ideas alrededor de".',
  '- cultivate: deep-dive a topic, gather supporting context. Best for "investiga / profundiza / cultiva el tema …".',
  '- journal_arc: get the agent\'s persistent journal / diary arc. Best for "qué he escrito / mi journal / arc / diario".',
  '- ai_ask: free-form Q&A through the configured LLM. Best for "explícame X / dime cómo / pregunta abierta".',
  '',
  'RULES:',
  '- Output ONLY a JSON object. No prose, no markdown, no code fences. Just \'{"tool": "...", "args": {...}}\'.',
  '- The args object must include the right key for that tool: query (recall/forage/synthesize/bloom), topic (cultivate), prompt (ai_ask), or no special key (map_network, journal_arc).',
  '- Preserve the original wording in the relevant arg.',
  '- If unsure, choose recall and put the full request as the query.',
].join('\n');

export interface ClassifiedIntent {
  tool: string;
  args: Record<string, unknown>;
}

const VALID_TOOLS = new Set([
  'recall', 'forage', 'synthesize', 'map_network', 'bloom',
  'cultivate', 'journal_arc', 'ai_ask',
]);

function fallback(query: string, userId: string): ClassifiedIntent {
  return { tool: 'recall', args: { query, userId } };
}

export async function classifyIntent(query: string, userId: string): Promise<ClassifiedIntent> {
  const trimmed = query.trim();
  if (!trimmed || !llmConfigured()) return fallback(trimmed, userId);
  try {
    const raw = await llmChat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: trimmed },
      ],
      { maxTokens: 200, temperature: 0, timeoutMs: TIMEOUT_MS },
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`[intent] no JSON in LLM response: ${raw.slice(0, 200)}`);
      return fallback(trimmed, userId);
    }
    const parsed = JSON.parse(jsonMatch[0]) as { tool?: string; args?: Record<string, unknown> };
    const tool = (parsed.tool ?? '').toLowerCase();
    if (!VALID_TOOLS.has(tool)) {
      console.error(`[intent] invalid tool: ${tool}`);
      return fallback(trimmed, userId);
    }
    const args: Record<string, unknown> = { ...(parsed.args ?? {}), userId };
    const needsQuery = ['recall', 'forage', 'synthesize', 'bloom'];
    if (needsQuery.includes(tool) && !args['query']) args['query'] = trimmed;
    if (tool === 'cultivate' && !args['topic']) args['topic'] = trimmed;
    if (tool === 'ai_ask' && !args['prompt']) args['prompt'] = trimmed;
    return { tool, args };
  } catch (e) {
    console.error(`[intent] failed: ${(e as Error).message}`);
    return fallback(trimmed, userId);
  }
}
