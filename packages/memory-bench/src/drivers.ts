// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Drivers — the "agent" that answers a question given memories recalled
 * from celiums-memory. Both arms go through DO Inference (one VPC-scoped
 * key, OpenAI-compatible). The Claude arm IS "Claude with the MCP
 * connected": same celiums-memory backend, same `recall`, the only
 * difference vs the interactive local client is that the loop is
 * automated and therefore reproducible.
 *
 *   - oss   : an OSS model (default gpt-oss-120b)
 *   - claude: DO Inference's anthropic-claude-* passthrough
 *
 * RAG contract: question + top-k recalled memories → grounded answer.
 * The prompt forbids using non-recalled knowledge and *permits explicit
 * abstention* (LongMemEval/LoCoMo penalise hallucinated answers to
 * unanswerable questions — abstention is the correct behaviour there).
 */

import type { Driver } from './types.js';

const DO_BASE = (process.env.DO_INFERENCE_URL || 'https://inference.do-ai.run/v1').replace(/\/$/, '');
const DO_KEY = process.env.DO_INFERENCE_KEY || '';

const SYSTEM = `You are answering a question using ONLY the retrieved memory snippets provided.
Rules:
- Use only the snippets. Do not use outside knowledge.
- If the snippets do not contain enough information to answer, reply exactly: I don't know.
- Be concise and direct. Answer the question, nothing else.
- Pay attention to timestamps in snippets for time-related questions.`;

async function doChat(model: string, system: string, user: string, maxTokens = 512): Promise<string> {
  const res = await fetch(`${DO_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(DO_KEY ? { Authorization: `Bearer ${DO_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`DO Inference ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j: any = await res.json();
  return String(j?.choices?.[0]?.message?.content ?? '').trim();
}

function buildUser(question: string, retrieved: string[]): string {
  const ctx = retrieved.length
    ? retrieved.map((s, i) => `[${i + 1}] ${s}`).join('\n')
    : '(no memories retrieved)';
  return `Retrieved memories:\n${ctx}\n\nQuestion: ${question}\nAnswer:`;
}

export function makeDriver(kind: 'oss' | 'claude'): Driver {
  const model =
    kind === 'oss'
      ? process.env.BENCH_OSS_MODEL || 'openai-gpt-oss-120b'
      : process.env.BENCH_CLAUDE_MODEL || 'anthropic-claude-4.6-sonnet';
  return {
    id: `${kind}:${model}`,
    async answer(question, retrieved) {
      return doChat(model, SYSTEM, buildUser(question, retrieved));
    },
  };
}
