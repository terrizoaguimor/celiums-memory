// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * POST /v1/ask — single-shot user-facing endpoint. Classify the prompt,
 * pick a model, forward to the foundation API, and return the plain answer.
 *
 * This is the replacement for celiums_ai's chat-style UX: callers don't have
 * to construct OpenAI message envelopes, they just send a prompt and get back
 * { answer, model_used, task_type, latency_ms, tokens }.
 *
 * Auth: Bearer fleet key. No streaming variant in v0.1.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { classify } from '../lib/classifier.js';
import { augmentMessages } from '../lib/prompt-library.js';
import { availableModels, modelById } from '../lib/registry.js';
import { forward, pickFallbacks } from '../lib/forwarder.js';
import { recordDecision } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';
import { reportConsumption } from '../lib/usage-client.js';
const app = new Hono();
// §7.1 (ATLAS_v4) — `conversation_id` is DEPRECATED and removed from the
// contract. /ask is single-turn and stateless by design (Atlas is a
// stateless gateway; conversation state belongs to celiums-memory, not
// here). Half-implemented state is worse than none — it invited callers
// to assume persistence. zod strips unknown keys, so callers still
// sending `conversation_id` get a clean ignore (not a 400) during the
// grace period. Multi-turn → /v1/chat/completions with a client-managed
// messages array.
const AskBody = z.object({
    prompt: z.string().min(1).max(32000),
    max_tokens: z.number().int().positive().max(8192).optional(),
    // Prompt augmentation (Atlas killer feature). Default ON; pass false to
    // get the raw model with no task-specialized system prompt.
    augment: z.boolean().optional(),
});
function getFleetKey(c) {
    const auth = c.req.header('authorization');
    if (auth && auth.startsWith('Bearer '))
        return auth.slice(7);
    return process.env.CELIUMS_FLEET_KEY || null;
}
app.post('/v1/ask', async (c) => {
    const t0 = performance.now();
    const requestId = `req_${randomUUID()}`;
    const auth = await authenticate(c);
    if (auth.reject) {
        return c.json({ error: { message: auth.reject.message, type: 'auth_error', tier: null } }, auth.reject.status);
    }
    if (!auth.fleetKey) {
        return c.json({ error: { message: 'CELIUMS_FLEET_KEY not configured', type: 'auth_error' } }, 500);
    }
    const fleetKey = auth.fleetKey;
    let raw;
    try {
        raw = await c.req.json();
    }
    catch {
        return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request' } }, 400);
    }
    const parsed = AskBody.safeParse(raw);
    if (!parsed.success) {
        return c.json({ error: { message: parsed.error.message, type: 'invalid_request' } }, 400);
    }
    const { prompt, max_tokens, augment } = parsed.data;
    // OSS #174 B2: no paid tiers — no tier-bound model pool.
    const allowedModels: string[] | undefined = undefined as string[] | undefined;
    const messages = [{ role: 'user', content: prompt }];
    const decision = await classify({ messages }, { fleetKey, allowedModels });
    const chosen = modelById(decision.model_id);
    if (!chosen) {
        return c.json({ error: { message: `classifier returned unknown model ${decision.model_id}`, type: 'internal_error' } }, 500);
    }
    // 1b. Prompt augmentation — inject the task-specialized system prompt.
    //     /ask always auto-routes and never carries a caller system message,
    //     so augment unless explicitly disabled.
    const fwdMessages = augment === false
        ? messages
        : augmentMessages(messages, decision.task);
    // 2. Build an OpenAI-compatible body and forward via the same forwarder
    //    that /v1/chat/completions uses.
    const ga = availableModels(false);
    const fallbacks = pickFallbacks(chosen, ga);
    const upstreamBody: Record<string, unknown> = {
        model: chosen.id,
        messages: fwdMessages,
        stream: false,
    };
    if (max_tokens)
        upstreamBody.max_completion_tokens = max_tokens;
    const abort = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => abort.abort());
    const result = await forward({ originalBody: upstreamBody, chosen, fallbacks, fleetKey }, abort.signal);
    const data = (await result.response.json().catch(() => null));
    const latency_ms = Math.round(performance.now() - t0);
    if (!result.response.ok) {
        return c.json({
            error: {
                message: data?.error?.message ?? 'upstream error',
                type: 'upstream_error',
                status: result.response.status,
            },
            model_used: result.modelUsed,
            task_type: decision.task,
            latency_ms,
        }, result.response.status as 400 | 401 | 403 | 404 | 500 | 502 | 503);
    }
    const answer = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage ?? {};
    const tokens = {
        in: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        out: usage.completion_tokens ?? usage.output_tokens ?? 0,
    };
    // Headers for parity with /v1/chat/completions observability.
    c.header('x-celiums-atlas-task', decision.task);
    c.header('x-celiums-atlas-model', result.modelUsed);
    c.header('x-celiums-atlas-from', decision.from);
    c.header('x-celiums-atlas-request-id', requestId);
    // Record the decision (fire-and-forget; never block the response).
    const promptHash = createHash('sha256').update(prompt).digest('hex');
    void recordDecision({
        request_id: requestId,
        user_id: c.req.header('x-celiums-user-id') ?? null,
        tenant_id: c.req.header('x-celiums-tenant-id') ?? null,
        prompt_hash: promptHash,
        prompt_preview: prompt.slice(0, 200),
        classifier_json: decision,
        model_chosen: result.modelUsed,
        fallback_chain: result.fallbackChain.length > 1 ? result.fallbackChain : null,
        input_tokens: tokens.in || null,
        output_tokens: tokens.out || null,
        tool_calls: 0,
        latency_ms,
        outcome: 'success',
        error_kind: null,
    });
    // Record consumption (fire-and-forget) for usage observability.
    // Frontier escapes counted when the chosen model is in the escape
    // set (sonnet/opus/o3/gpt-5.4-pro/gpt-5.2-pro).
    if (auth.mode === 'user' && auth.apiKey) {
        const FRONTIER_ESCAPE = /(opus|gpt-5\.4-pro|gpt-5\.2-pro|gpt-5\.3-codex|gpt-5\.1-codex-max|sonnet|^openai-o[13])/i;
        const isEscape = FRONTIER_ESCAPE.test(result.modelUsed);
        void reportConsumption({
            apiKey: auth.apiKey,
            model: result.modelUsed,
            tokensIn: tokens.in,
            tokensOut: tokens.out,
            escapes: isEscape ? 1 : 0,
        });
    }
    return c.json({
        answer,
        model_used: result.modelUsed,
        task_type: decision.task,
        latency_ms,
        tokens,
        tier: null,
    });
});
export default app;
