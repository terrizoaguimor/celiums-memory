// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Dispatcher Client — Atlas-side wrapper around DigitalOcean Inference Router.
 *
 * Flow when feature flag ATLAS_USE_DISPATCHER=true:
 *   1. `classifyViaDispatcher(messages)` → POST router:celiums-dispatcher with
 *      a system prompt that forces JSON output: {route, confidence, reason}.
 *      The dispatcher router internally picks the matching task
 *      (route-to-coder / route-to-writing / etc) and a cheap OSS model from
 *      its pool emits the label.
 *   2. `invokeRouter(route, originalBody)` → POST router:<route> with the
 *      user's original request. The downstream router picks the right
 *      sub-task and a model from that task's pool, returns the real answer.
 *
 * This module deliberately does NOT touch Atlas's tier-accounting, recording,
 * or auth — those layers stay in routes/chat.ts. It only handles the
 * router-specific call mechanics.
 *
 * Why a separate module: keeps the dispatcher path isolated from the legacy
 * classifier+forwarder. When metrics confirm the dispatcher path wins,
 * deleting it is a single import removal in chat.ts.
 */

const INFERENCE_URL = process.env.INFERENCE_URL || 'https://inference.do-ai.run';

/** Optional override: a separate Model Access Key (doo_v1_*) scoped for
 *  router invocations. When set, ALL dispatcher and downstream-router calls
 *  use this key instead of the legacy CELIUMS_FLEET_KEY. Keeps the legacy
 *  classifier+forwarder path unaffected by router auth scope. */
function routerKey(fallback: string): string {
  return process.env.ATLAS_DISPATCHER_KEY || fallback;
}

/** System prompt injected into the dispatcher call. Forces a strict JSON
 *  classification so we can parse the route deterministically. */
const DISPATCH_SYSTEM = `You are a router classifier for the Celiums system. Read the user's request and decide which downstream router should handle it. Available downstream routers:

- celiums-coder        — source code: write, edit, debug, review, refactor, test
- celiums-research     — deep analysis, fact-check, comparisons, multi-source synthesis
- celiums-writing      — long-form text: blog, technical doc, marketing copy, creative
- celiums-reasoning    — multi-step logic, math proofs, planning decomposition, puzzles
- celiums-conversation — casual chat, simple Q&A, explain-concept, translate, paraphrase
- celiums-utility      — fast mechanical operations: classify, summary <100 words, extract entities, format conversion
- celiums-vision       — image input: describe, OCR, compare images, chart analysis

Output ONLY a compact JSON object — no markdown fences, no prose, no preamble — matching exactly:
{"route":"celiums-<one of the above>","confidence":0.0-1.0,"reason":"<≤12 words>"}

Never answer the user's underlying question. Your job is classification only.`;

export interface DispatcherDecision {
  route: string;                    // "celiums-coder" | "celiums-research" | ...
  confidence: number;               // 0..1 as returned by the classifier
  reason: string;                   // short rationale
  selectedRoute: string | null;     // x-model-router-selected-route header (e.g. "route-to-coder")
  classifierModel: string | null;   // which OSS model actually emitted the JSON
}

export interface DispatcherInvocation {
  response: Response;               // upstream response (caller streams or buffers)
  modelUsed: string;                // final model id DO selected for the downstream task
  selectedRoute: string | null;     // x-model-router-selected-route header (sub-task picked by downstream router)
}

const VALID_ROUTES = new Set([
  'celiums-coder',
  'celiums-research',
  'celiums-writing',
  'celiums-reasoning',
  'celiums-conversation',
  'celiums-utility',
  'celiums-vision',
]);

function lastUserText(messages: any[]): string {
  const u = [...messages].reverse().find((m) => m.role === 'user');
  if (!u) return '';
  return typeof u.content === 'string'
    ? u.content
    : Array.isArray(u.content)
      ? u.content.map((p: any) => p.text ?? '').join(' ')
      : '';
}

/** Step 1: ask the dispatcher router which downstream router to use. */
export async function classifyViaDispatcher(
  messages: any[],
  fleetKey: string,
  signal?: AbortSignal,
): Promise<DispatcherDecision | null> {
  const userText = lastUserText(messages);
  if (!userText) return null;

  const body = {
    model: 'router:celiums-dispatcher',
    messages: [
      { role: 'system', content: DISPATCH_SYSTEM },
      // Only send the trailing user turn — the dispatcher doesn't need the
      // full history to classify intent and shorter prompts are cheaper.
      { role: 'user', content: userText.slice(0, 4000) },
    ],
    max_completion_tokens: 80,
    temperature: 0.1,
    stream: false,
  };

  const res = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${routerKey(fleetKey)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    console.error(`[celiums-atlas] dispatcher upstream ${res.status}`);
    return null;
  }

  const data: any = await res.json();
  const raw = data?.choices?.[0]?.message?.content
    ?? data?.choices?.[0]?.message?.reasoning_content
    ?? '';
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[celiums-atlas] dispatcher returned no JSON block');
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    const route = String(parsed.route ?? '').trim();
    if (!VALID_ROUTES.has(route)) {
      console.error(`[celiums-atlas] dispatcher returned unknown route: ${route}`);
      return null;
    }
    return {
      route,
      confidence: Number(parsed.confidence ?? 0.5),
      reason: String(parsed.reason ?? '(no reason)').slice(0, 200),
      selectedRoute: res.headers.get('x-model-router-selected-route'),
      classifierModel: data?.model ?? null,
    };
  } catch (e) {
    console.error(`[celiums-atlas] dispatcher JSON parse failed: ${(e as Error).message}`);
    return null;
  }
}

/** Step 2: forward the original request to the chosen downstream router.
 *  The downstream router (e.g. router:celiums-coder) picks its own sub-task
 *  and underlying model. Returns the upstream Response untouched so the
 *  caller can stream or buffer as needed. */
export async function invokeRouter(
  route: string,                    // e.g. "celiums-coder"
  originalBody: any,
  fleetKey: string,
  signal?: AbortSignal,
): Promise<DispatcherInvocation> {
  if (!VALID_ROUTES.has(route)) {
    throw new Error(`invokeRouter: invalid route ${route}`);
  }

  // Rewrite ONLY the model field; preserve messages, tools, stream, etc.
  // The downstream router handles minMaxTokens / toolCalling at its own
  // task level via the model pool. We don't need Atlas's per-model
  // registry rewrite logic here.
  const body = { ...originalBody, model: `router:${route}` };

  const res = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${routerKey(fleetKey)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  // For non-streaming responses we'll buffer in the caller; for streaming
  // we hand back the raw Response. modelUsed comes from the JSON body for
  // non-streaming, or from the trailing SSE `data:` chunk for streaming —
  // caller resolves that. Here we expose whatever the headers tell us.
  const selectedRoute = res.headers.get('x-model-router-selected-route');

  // Capture model_used from a non-streaming response without consuming the
  // body. We can't await res.json() here because callers stream — so we
  // leave it null and let the caller fill it once they read the body.
  return {
    response: res,
    modelUsed: '',         // filled in by caller after reading body
    selectedRoute,
  };
}

/** Convenience: full classify→invoke flow as a single call. Used when the
 *  caller doesn't need to inject anything between classification and
 *  invocation (i.e. the common path). Returns null on classification
 *  failure so the caller can fall back to the legacy classifier+forwarder. */
export async function dispatchAndInvoke(
  originalBody: any,
  fleetKey: string,
  signal?: AbortSignal,
): Promise<{ decision: DispatcherDecision; invocation: DispatcherInvocation } | null> {
  const decision = await classifyViaDispatcher(originalBody.messages, fleetKey, signal);
  if (!decision) return null;

  const invocation = await invokeRouter(decision.route, originalBody, fleetKey, signal);
  return { decision, invocation };
}

export function dispatcherEnabled(): boolean {
  return process.env.ATLAS_USE_DISPATCHER === 'true' || process.env.ATLAS_USE_DISPATCHER === '1';
}
