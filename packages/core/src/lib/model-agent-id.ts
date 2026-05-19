// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Helper: derive a stable `agent_id` from a provider model id.
 *
 * The journal is scoped to `agent_id`. We want stable ids across minor
 * model version bumps so the agent's journal survives upgrades. E.g.:
 *   llama3.3-70b-instruct  → llama-3.3-70b
 *   llama-3.3-70b-instruct → llama-3.3-70b
 *   qwen3.5-397b-a17b      → qwen-3.5-397b
 *   deepseek-3.2           → deepseek-3.2
 *   gemma-4-31B-it         → gemma-4-31b
 *   anthropic-claude-haiku-4.5 → anthropic-claude-haiku-4.5 (kept as-is;
 *                              filter prevents closed models from reaching
 *                              this path)
 *
 * Rules:
 *   - lowercase everything
 *   - normalize "X.YZ" version glued to family: insert dash (llama3 → llama-3)
 *   - drop tuning suffixes: -instruct, -it, -chat, -base, -hf
 *   - drop MoE shard hints: -a17b, -a32b, -a8x22b
 *   - collapse repeated dashes
 *
 * Stable for journal scoping even if the provider rebrands the upstream
 * id slightly.
 */
export function modelIdToAgentId(modelId: string): string {
  let id = modelId.toLowerCase().trim();

  // Insert dash before first digit/version cluster if missing.
  // "llama3.3" → "llama-3.3"; "qwen3.5" → "qwen-3.5"; keeps "claude-3-5" intact.
  id = id.replace(/^([a-z]+)(\d)/, '$1-$2');

  // Drop tuning suffixes.
  const suffixesToStrip = ['-instruct', '-it', '-chat', '-base', '-hf'];
  for (const s of suffixesToStrip) {
    if (id.endsWith(s)) {
      id = id.slice(0, -s.length);
      break;
    }
  }

  // Drop MoE active-param hints at the tail: -a17b, -a32b, -a3x8b
  id = id.replace(/-a\d+(?:x\d+)?b$/i, '');

  // Collapse double dashes.
  id = id.replace(/--+/g, '-');

  // Trim leading/trailing dashes.
  id = id.replace(/^-+|-+$/g, '');

  return id;
}

/**
 * Inverse: given a list of message rows in a conversation, return the set
 * of distinct `agent_id`s that have contributed (other than the current
 * model). Used to compute `inherit_from` for journal_recall — so the
 * current model can read the notes of every predecessor that touched
 * this conversation.
 */
export function predecessorAgentIds(
  messageModels: Array<string | null | undefined>,
  currentAgentId: string,
): string[] {
  const set = new Set<string>();
  for (const m of messageModels) {
    if (!m) continue;
    const aid = modelIdToAgentId(m);
    if (aid && aid !== currentAgentId) set.add(aid);
  }
  return Array.from(set);
}
