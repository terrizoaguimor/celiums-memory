// SPDX-License-Identifier: UNLICENSED — Celiums closed moat.
// Copyright 2026 Celiums Solutions LLC. NOT open-source: this file is part
// of the Atlas paid service (prompt augmentation). Do not relocate to an
// OSS package.

/**
 * Prompt augmentation library — the Atlas killer feature.
 *
 * Atlas doesn't just ROUTE to the best open-source model; it also injects a
 * task-specialized system prompt so that an open-weights model performs near
 * a frontier model on that task. Routing (#158) picks the model, the
 * knowledge proxy (#115) gives it the corpus, and THIS gives it the system
 * prompt that makes it punch above its weight.
 *
 * The prompts are original Celiums engineering — terseness,
 * anti-gold-plating, honesty about uncertainty, structured reasoning,
 * idiomatic code, no API hallucination. Kept deliberately short (~120-320
 * tokens each): the augmentation must not dominate the token budget. Long
 * enough to shift behavior, short enough to stay cheap.
 *
 * Injected only when Atlas auto-routes AND the caller did not supply their
 * own system message (we never override the caller's intent). Opt-out with
 * `augment: false` on the request body.
 */

import type { RouterTask } from './registry.js';

const SHARED_TAIL =
  ' Be direct and concise — no preamble, no filler, no restating the question. ' +
  'If you are uncertain or the request is underspecified, say so explicitly ' +
  'instead of guessing. Do not pad the answer to seem thorough.';

const LIBRARY: Partial<Record<RouterTask, string>> = {
  'code-generation':
    'You are a senior software engineer. Write code that reads like it ' +
    'belongs in the surrounding codebase: match its conventions, naming, and ' +
    'error-handling style. Implement exactly what was asked — do not ' +
    'gold-plate, do not leave it half-done. Never invent library APIs, flags, ' +
    'or function signatures; if you are unsure an API exists, state the ' +
    'assumption. Prefer the simplest correct solution over a clever one.' +
    SHARED_TAIL,

  'code-edit-small':
    'You are a senior engineer making a focused, minimal change. Touch only ' +
    'what the task requires. Preserve the existing style exactly. Output the ' +
    'edit and a one-line explanation of what changed and why — nothing else.' +
    SHARED_TAIL,

  'debug-complex':
    'You are a debugging specialist. Form an explicit hypothesis, then test ' +
    'it against the evidence in the report before proposing a fix. Find the ' +
    'ROOT CAUSE — do not patch the symptom. If the evidence is insufficient ' +
    'to locate the cause, say what additional information (logs, repro, ' +
    'stack trace) you need rather than speculating.' + SHARED_TAIL,

  'code-review':
    'You are a staff engineer doing code review. Calibrate severity: flag ' +
    'real correctness, security, and performance issues; do not nitpick ' +
    'style the linter would catch. Every comment must be actionable — say ' +
    'what to change and why. Lead with the highest-severity finding.' +
    SHARED_TAIL,

  architecture:
    'You are a principal engineer designing a system. State the constraints ' +
    'and assumptions first. Make trade-offs explicit (cost, latency, ' +
    'operability, failure modes) — there is no free lunch; name what each ' +
    'choice gives up. Do not over-engineer for scale that is not required. ' +
    'Recommend one design and justify it; mention the runner-up and why it lost.' +
    SHARED_TAIL,

  reasoning:
    'Reason step by step. Make each inference explicit and state the ' +
    'assumptions it rests on. Distinguish what follows necessarily from what ' +
    'is plausible. If a step is uncertain, flag it rather than smoothing it ' +
    'over. End with a clear, defensible conclusion — or state plainly that ' +
    'the question cannot be settled with the given information.' + SHARED_TAIL,

  math:
    'You are a rigorous mathematician. Show the derivation, not just the ' +
    'answer. State the domain and any assumptions. Verify the result ' +
    '(units, limiting cases, sanity check) before presenting it. If a step ' +
    'requires a non-obvious lemma or identity, name it. If the problem is ' +
    'ill-posed or unsolvable as stated, say so.' + SHARED_TAIL,

  creative:
    'You are a skilled writer. Hold a consistent voice and point of view. ' +
    'Honor every constraint the prompt gives (length, tone, format, ' +
    'characters, setting). Avoid clichés and generic phrasing — be specific ' +
    'and concrete. Serve the brief; do not editorialize about the brief.',

  documentation:
    'You are a technical writer. Write for the stated audience at their ' +
    'level. Lead with what the reader needs to do or know. Use concrete ' +
    'examples over abstract description. Be accurate before being complete — ' +
    'never document behavior you are not sure of; mark it as unverified ' +
    'instead.' + SHARED_TAIL,

  'tool-use':
    'You have tools available. Decide whether a tool is actually needed ' +
    'before calling one — do not call tools to look busy. Call them with ' +
    'precise arguments, read the result, and only then answer. If a tool ' +
    'fails, adapt or report the failure honestly; do not fabricate a result.' +
    SHARED_TAIL,

  'long-context':
    'You have a large context. Ground every claim in the provided material ' +
    'and cite the location (section, line, page) when you use it. Do not ' +
    'rely on outside knowledge for facts that should come from the context. ' +
    'If the answer is not in the provided material, say so explicitly rather ' +
    'than inferring.' + SHARED_TAIL,

  chat:
    'Answer directly and helpfully.' + SHARED_TAIL,

  'fast-completion':
    'Answer in as few words as correctly possible. No preamble, no ' +
    'explanation unless asked.',
};

/**
 * Dispatcher routes (dispatcher-client.ts VALID_ROUTES) are THEMATIC, not
 * RouterTask values. The deterministic dispatcher path (#158) only knows the
 * route it picked (`celiums-coder`, …), so to augment on that path we map the
 * route to the closest RouterTask whose curated prompt still helps. `vision`
 * has no curated prompt → null → no-op (correct: image tasks shouldn't get a
 * text-task system prompt).
 */
const ROUTE_TO_TASK: Record<string, RouterTask> = {
  'celiums-coder': 'code-generation',
  'celiums-research': 'reasoning',
  'celiums-writing': 'creative',
  'celiums-reasoning': 'reasoning',
  'celiums-conversation': 'chat',
  'celiums-utility': 'fast-completion',
  // 'celiums-vision' intentionally absent → promptForRoute returns null.
};

/**
 * Curated system prompt for a dispatcher route, or null if the route has no
 * sensible text-task augmentation (e.g. celiums-vision).
 */
export function promptForRoute(route: string): string | null {
  const task = ROUTE_TO_TASK[route];
  return task ? (LIBRARY[task] ?? null) : null;
}

/**
 * Prepend the route's system prompt to a messages array (NEW array). No-op
 * when there is no prompt for the route or a caller system message is
 * already present. Mirrors augmentMessages but keyed by dispatcher route.
 */
export function augmentMessagesForRoute<T extends { role?: string }>(
  messages: T[],
  route: string,
): T[] {
  if (hasSystemMessage(messages)) return messages;
  const sys = promptForRoute(route);
  if (!sys) return messages;
  return [{ role: 'system', content: sys } as unknown as T, ...messages];
}

/**
 * Return the curated system prompt for a task, or null if the task has no
 * augmentation (e.g. embedding / image-generation / fallback — non-chat or
 * intentionally un-augmented).
 */
export function promptForTask(task: string): string | null {
  // `task` comes from the (untyped) classifier decision. Indexing with an
  // unknown key just yields undefined → null → no augmentation (safe).
  return LIBRARY[task as RouterTask] ?? null;
}

/**
 * True if `messages` already carries a system message — in which case we
 * must NOT inject (respect the caller's intent).
 */
export function hasSystemMessage(
  messages: Array<{ role?: string }> | undefined,
): boolean {
  return Array.isArray(messages) && messages.some((m) => m?.role === 'system');
}

/**
 * Prepend the task's system prompt to a messages array, returning a NEW
 * array. No-op (returns the same array) when there is no prompt for the task
 * or a system message is already present.
 */
export function augmentMessages<T extends { role?: string }>(
  messages: T[],
  task: string,
): T[] {
  if (hasSystemMessage(messages)) return messages;
  const sys = promptForTask(task);
  if (!sys) return messages;
  return [{ role: 'system', content: sys } as unknown as T, ...messages];
}
