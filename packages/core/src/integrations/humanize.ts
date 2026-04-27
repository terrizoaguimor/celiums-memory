/**
 * Pipe raw MCP tool output through an LLM to produce a human-readable
 * markdown summary suitable for rendering inline in Notion, Slack, a
 * dashboard — anywhere a user reads tool output.
 *
 * Uses the generic OpenAI-compatible `llmChat` from llm-client. If the
 * user has not configured an LLM (no `CELIUMS_LLM_API_KEY`), we fall
 * back to the raw text rather than throwing — the caller keeps moving.
 *
 * Trade-off: humanize is opportunistic polish, not a hard requirement.
 * Tools that strictly need an LLM should call `llmChat` directly and
 * surface their own error when the user hasn't configured a key.
 */

import { llmChat, llmConfigured } from '../llm-client.js';

const SYSTEM_PROMPT = [
  'You format raw output from Celiums Memory tools (MCP) into clean markdown for a notebook page.',
  '',
  'STRICT RULES:',
  '- Output ONLY markdown. No preface like "Here is...". No code fences around the whole answer.',
  '- Use ## or ### headings for sections, bullet lists for items, short paragraphs for prose.',
  '- For lists of memories / modules / findings: each bullet has ONE short summary line, then a sub-line in *italics* with the date and 2-3 tags.',
  '- NEVER show: scores, embedding ids, jsonb internals, importance numbers, mood floats, raw tags arrays.',
  '- For narrative output (synthesize, free-form Q&A): polish lightly, keep meaning. Markdown formatting only.',
  '- Always answer in the user\'s language (Spanish if the question was Spanish).',
  '- If the raw payload is empty or contains an error, say so plainly in one line.',
  '- Maximum ~350 words. The user reads this inline; brevity wins.',
].join('\n');

const HUMANIZE_TIMEOUT_MS = 30_000;
const MAX_RAW_INPUT = 12_000;

export interface HumanizeInput {
  toolName: string;
  userQuery: string;
  rawText: string;
}

/**
 * Returns markdown ready to be rendered. Falls back to the raw text on
 * any error — never throws.
 */
export async function humanize(input: HumanizeInput): Promise<string> {
  const trimmed = (input.rawText ?? '').trim();
  if (trimmed.length === 0) return '_(no output)_';
  if (!llmConfigured()) return input.rawText;

  const userPrompt = [
    `User invoked tool \`${input.toolName}\` with this query:`,
    `> ${input.userQuery || '(no query)'}`,
    '',
    'Raw tool output:',
    '```',
    trimmed.slice(0, MAX_RAW_INPUT),
    '```',
    '',
    'Format the answer for the user. Markdown only.',
  ].join('\n');

  try {
    const md = await llmChat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 900, timeoutMs: HUMANIZE_TIMEOUT_MS },
    );
    return md.trim().length > 0 ? md.trim() : input.rawText;
  } catch (e) {
    console.error(`[humanize] failed: ${(e as Error).message}`);
    return input.rawText;
  }
}
