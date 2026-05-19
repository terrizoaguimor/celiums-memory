// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Memory client for the benchmark — the SYSTEM UNDER TEST.
 *
 * Talks to celiums-memory over its MCP JSON-RPC endpoint:
 *   - `remember`  to ingest each haystack session
 *   - `recall`    to retrieve at QA time
 *
 * ISOLATION (non-negotiable): every bench run scopes its memories to
 * projectId = `bench:<runId>` so it never reads or pollutes a real user's
 * memory, PAD state, or circadian profile. The benchmark must measure the
 * retrieval algorithm, not Mario's actual memories.
 *
 * In-VPC: MEMORY_BASE_URL points at the in-cluster Service of the
 * bench-dedicated celiums-memory deployment (NOT prod memory.celiums.ai).
 * Auth via CELIUMS_BENCH_CMK (a scoped key, env-only, never committed).
 */

const BASE = (process.env.MEMORY_BASE_URL || 'http://celiums-memory-bench.distill.svc.cluster.local:3210').replace(/\/$/, '');
const CMK = process.env.CELIUMS_BENCH_CMK || '';

async function mcp(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(CMK ? { Authorization: `Bearer ${CMK}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`mcp ${name} HTTP ${res.status}`);
  const j: any = await res.json();
  const text = j?.result?.content?.[0]?.text;
  if (j?.error) throw new Error(`mcp ${name}: ${JSON.stringify(j.error).slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export class BenchMemory {
  constructor(private readonly runId: string) {}
  private get projectId() { return `bench:${this.runId}`; }

  /** Ingest one session's turns as memories, preserving session order +
   *  timestamp (temporal-reasoning questions depend on this). */
  async ingestSession(s: { sessionId: string; timestamp?: string; turns: { role: string; content: string }[] }): Promise<void> {
    for (let i = 0; i < s.turns.length; i++) {
      const t = s.turns[i];
      const stamp = s.timestamp ? ` [${s.timestamp}]` : '';
      await mcp('remember', {
        userId: `bench-${this.runId}`,
        projectId: this.projectId,
        content: `(${s.sessionId}#${i}, ${t.role})${stamp} ${t.content}`,
        tags: ['bench', s.sessionId, this.runId],
      });
    }
  }

  /** Retrieve top memories for the question, scoped to this run only. */
  async recall(query: string, limit = 12): Promise<string[]> {
    const r = await mcp('recall', {
      query, userId: `bench-${this.runId}`, projectId: this.projectId, limit,
    });
    const rows = Array.isArray(r?.memories) ? r.memories : Array.isArray(r) ? r : [];
    return rows.map((m: any) => String(m.content ?? m.memory?.content ?? '')).filter(Boolean);
  }
}
