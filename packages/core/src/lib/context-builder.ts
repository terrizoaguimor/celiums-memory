// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Pre-turn context builder — the moat.
 *
 * Para cada turno del agent, este módulo:
 *   1. Hace `recall` semántico sobre las memorias del USUARIO con el
 *      mensaje del usuario como query.
 *   2. Hace `journal_recall` sobre el journal del MODELO actual.
 *   3. Si hay modelos predecesores en la conversación, hace
 *      `journal_recall(inherit_from=<predecessor>)` para que el modelo
 *      nuevo lea las notas del anterior.
 *   4. Arma un system prompt estructurado con todo eso.
 *
 * Esto es lo que diferencia Celiums: el modelo NUNCA arranca ciego.
 * Memorias del usuario son del usuario (cross-modelo). Journal es del
 * modelo (cada uno el suyo). Continuidad sin alucinación.
 *
 * Reusa `dispatchMcp` para que el pipeline auth/RBAC/ethics aplique
 * idéntico a cuando un agente externo invoca esas tools.
 */

import { dispatchMcp } from '../mcp/dispatcher.js';
import type { McpToolContext } from '../mcp/types.js';
import { newRequestId } from './sse-broker.js';

export interface ContextBuildInput {
  userMessage: string;
  userId: string;
  modelAgentId: string;
  predecessorAgentIds: string[];
  mcpCtx: McpToolContext;
  /** Optional persona to prepend. Defaults to a minimal Celiums identity. */
  personaPreamble?: string;
}

export interface ContextBuiltResult {
  systemPrompt: string;
  memoriesUsed: number;
  ownJournalUsed: number;
  inheritedJournalUsed: number;
}

async function callTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const envelope = {
    jsonrpc: '2.0' as const,
    id: newRequestId(),
    method: 'tools/call' as const,
    params: { name, arguments: args },
  };
  try {
    const r = (await dispatchMcp(envelope, ctx, process.env)) as {
      result?: { content?: Array<{ text?: string }> };
      error?: { message?: string };
    };
    if (r.error) return null;
    const first = r.result?.content?.[0]?.text;
    if (!first) return null;
    try {
      return JSON.parse(first);
    } catch {
      return first;
    }
  } catch {
    return null;
  }
}

const DEFAULT_PERSONA = `Sos Celiums, agente con memoria persistente. Tu identidad es el usuario que tenés enfrente, no el modelo que te corre. Operás con dos fuentes de continuidad:

1. **Memorias del usuario**: hechos, preferencias y decisiones que pertenecen a la persona. Son tuyas a través de cualquier modelo.
2. **Tu journal**: notas que VOS (este modelo) tomaste sobre soluciones, decisiones y lecciones. Son auditables y específicas a tu identidad como modelo.

Cuando otro modelo trabajó antes en esta conversación, podés leer SU journal — no para imitarlo, sino para tener continuidad sin alucinar.

Reglas:
- No inventes detalles del usuario que no aparezcan en sus memorias.
- Cuando tomes una decisión que valga preservar, invocá la tool \`journal_write\`.
- Cuando aprendas algo NUEVO sobre el usuario, invocá \`memory_remember\` con importance alta.
- Si necesitás contexto más profundo, invocá \`memory_recall\` con queries específicos.`;

export async function buildTurnContext(
  input: ContextBuildInput,
): Promise<ContextBuiltResult> {
  // 1. Memorias del usuario (semantic recall).
  const memoryResult = (await callTool(input.mcpCtx, 'recall', {
    query: input.userMessage,
    limit: 8,
  })) as { memories?: Array<{ content?: string; importance?: number; tags?: string[]; memory_type?: string }> } | null;
  const memories = memoryResult?.memories ?? [];

  // 2. Journal del modelo actual.
  const ownJournalResult = (await callTool(input.mcpCtx, 'journal_recall', {
    query: input.userMessage,
    limit: 5,
    // El MCP tool por default scopea al agent_id del caller. Si necesitamos
    // override (eg. server invoca para un modelo específico) hay que pasarlo
    // explícito — eso lo hace el dispatcher si el mcpCtx tiene agent_id set.
  })) as { entries?: Array<{ content?: string; entry_type?: string; valence?: number; tags?: string[] }> } | null;
  const ownJournal = ownJournalResult?.entries ?? [];

  // 3. Journals de modelos predecesores (inherit_from).
  const inheritedJournals: Array<{
    fromAgent: string;
    entries: Array<{ content?: string; entry_type?: string; tags?: string[] }>;
  }> = [];
  for (const predecessor of input.predecessorAgentIds.slice(0, 3)) {
    const r = (await callTool(input.mcpCtx, 'journal_recall', {
      query: input.userMessage,
      limit: 3,
      inherit_from: predecessor,
    })) as { entries?: Array<{ content?: string; entry_type?: string; tags?: string[] }> } | null;
    if (r?.entries && r.entries.length > 0) {
      inheritedJournals.push({ fromAgent: predecessor, entries: r.entries });
    }
  }

  // 4. Compose system prompt.
  const lines: string[] = [];
  lines.push(input.personaPreamble ?? DEFAULT_PERSONA);
  lines.push('');
  lines.push(`# Identidad operativa`);
  lines.push(`Modelo actual: \`${input.modelAgentId}\``);
  lines.push(`User: \`${input.userId}\``);
  lines.push('');

  if (memories.length > 0) {
    lines.push(`# Memorias del usuario (relevantes a este turno)`);
    for (const m of memories) {
      const imp =
        typeof m.importance === 'number' ? `imp=${m.importance.toFixed(2)}` : '';
      const type = m.memory_type ? `[${m.memory_type}]` : '';
      const tags = m.tags && m.tags.length > 0 ? `tags: ${m.tags.slice(0, 4).map((t) => '#' + t).join(' ')}` : '';
      lines.push(`- ${type} ${imp} ${tags}`.trim());
      lines.push(`  "${(m.content ?? '').slice(0, 300)}"`);
    }
    lines.push('');
  } else {
    lines.push(`# Memorias del usuario`);
    lines.push(`(El usuario no tiene memorias persistidas relevantes a este turno. Si aprendés algo importante, invocá memory_remember.)`);
    lines.push('');
  }

  if (ownJournal.length > 0) {
    lines.push(`# Tu journal (entries relevantes que VOS escribiste antes)`);
    for (const e of ownJournal) {
      const t = e.entry_type ? `[${e.entry_type}]` : '';
      const v = typeof e.valence === 'number' ? `(val ${e.valence > 0 ? '+' : ''}${e.valence.toFixed(2)})` : '';
      lines.push(`- ${t} ${v}`.trim());
      lines.push(`  "${(e.content ?? '').slice(0, 300)}"`);
    }
    lines.push('');
  }

  if (inheritedJournals.length > 0) {
    lines.push(`# Notas de modelos previos en esta conversación`);
    lines.push(`(Estos son extractos del journal de OTROS modelos que trabajaron contigo en este chat. Léelos como contexto histórico — NO los imites como si fueran tuyos.)`);
    for (const block of inheritedJournals) {
      lines.push('');
      lines.push(`## ${block.fromAgent} escribió:`);
      for (const e of block.entries) {
        const t = e.entry_type ? `[${e.entry_type}]` : '';
        lines.push(`- ${t}`.trim());
        lines.push(`  "${(e.content ?? '').slice(0, 300)}"`);
      }
    }
    lines.push('');
  }

  return {
    systemPrompt: lines.join('\n').trim(),
    memoriesUsed: memories.length,
    ownJournalUsed: ownJournal.length,
    inheritedJournalUsed: inheritedJournals.reduce((sum, b) => sum + b.entries.length, 0),
  };
}
