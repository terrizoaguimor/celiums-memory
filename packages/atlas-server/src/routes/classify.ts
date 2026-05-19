// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * POST /v1/classify — expose the internal classifier to clients.
 *
 * Wraps the same `classify()` used by /v1/chat/completions but takes a plain
 * prompt string and returns a richer envelope (alternatives, requirements,
 * latency) that celiums-memory's router-tools.ts already expects.
 *
 * Auth: Bearer fleet key (matches chat.ts pattern).
 * Classifier model: whatever lib/classifier.ts uses (currently openai-gpt-oss-20b
 * via INFERENCE_URL); heuristic fast-path may bypass the LLM call.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { classify, extractRequirements } from '../lib/classifier.js';
import { availableModels, modelById } from '../lib/registry.js';
import { authenticate } from '../lib/auth.js';
const app = new Hono();
const ClassifyBody = z.object({
    prompt: z.string().min(1).max(8000),
    hint: z.string().optional(),
    context: z.string().optional(),
});
function getFleetKey(c) {
    const auth = c.req.header('authorization');
    if (auth && auth.startsWith('Bearer '))
        return auth.slice(7);
    return process.env.CELIUMS_FLEET_KEY || null;
}
/** Map classifier complexity ('simple|medium|complex') to public ('low|medium|high'). */
function mapComplexity(c) {
    if (c === 'simple')
        return 'low';
    if (c === 'complex')
        return 'high';
    return 'medium';
}
/** Top-3 chat-model alternatives in the same tier as the recommended model, cheapest first.
 *  Filters by category==='chat' so that embed/image/tts/video models don't leak into the
 *  fallback list (a regression that would surface as alternatives like
 *  qwen3-tts-voicedesign or all-mini-lm-l6-v2 for a code-generation task). */
function pickAlternatives(recommended, ga) {
    return ga
        .filter((m) => m.category === 'chat' && m.tier === recommended.tier && m.id !== recommended.id)
        .sort((a, b) => (a.inputPer1M + a.outputPer1M) - (b.inputPer1M + b.outputPer1M))
        .slice(0, 3)
        .map((m) => m.id);
}
app.post('/v1/classify', async (c) => {
    const t0 = performance.now();
    const auth = await authenticate(c);
    if (auth.reject) {
        return c.json({ error: { message: auth.reject.message, type: 'auth_error', tier: null } }, auth.reject.status);
    }
    if (!auth.fleetKey) {
        return c.json({ error: { message: 'CELIUMS_FLEET_KEY not configured for upstream call', type: 'auth_error' } }, 500);
    }
    let raw;
    try {
        raw = await c.req.json();
    }
    catch {
        return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request' } }, 400);
    }
    const parsed = ClassifyBody.safeParse(raw);
    if (!parsed.success) {
        return c.json({ error: { message: parsed.error.message, type: 'invalid_request' } }, 400);
    }
    const { prompt, hint, context } = parsed.data;
    const messages: Array<{ role: string; content: string }> = [];
    if (hint) messages.push({ role: 'system', content: hint });
    if (context) messages.push({ role: 'system', content: `Context:\n${context}` });
    messages.push({ role: 'user', content: prompt });
    const reqs = extractRequirements({ messages });
    const allowedModels: string[] | undefined = undefined as string[] | undefined;
    const decision = await classify({ messages }, { fleetKey: auth.fleetKey, allowedModels });
    const recommended = modelById(decision.model_id);
    if (!recommended) {
        return c.json({ error: { message: `classifier returned unknown model ${decision.model_id}`, type: 'internal_error' } }, 500);
    }
    const ga = availableModels(false);
    const allowedSet = allowedModels && allowedModels.length > 0 ? new Set(allowedModels) : null;
    const filtered = allowedSet ? ga.filter((m) => allowedSet.has(m.id)) : ga;
    const alternatives = pickAlternatives(recommended, filtered);
    const latency_ms = Math.round(performance.now() - t0);
    return c.json({
        task_type: decision.task,
        complexity: mapComplexity(decision.complexity),
        // §7.6 — these were dead schema (always false even when task_type
        // was vision/tool-use/long-context, because they read only the
        // structured input shape, never the inferred task). Now backed by
        // task_type so they carry a real signal, single source of truth.
        needs_tools: reqs.needsTools || decision.task === 'tool-use',
        needs_vision: reqs.needsVision || decision.task === 'vision',
        needs_long_context: reqs.needsLongContext || decision.task === 'long-context',
        estimated_tokens: reqs.estimatedTokens,
        recommended_model: recommended.id,
        // §7.5 — the recommended model's capability tier (fast | workhorse |
        // pro-thinking | premium). The ATLAS.md valoración expected this and
        // saw it null because `tier` below is the ACCOUNT tier (plan/quota),
        // which is null when the key has no plan. They are different things.
        model_tier: recommended.tier,
        alternatives,
        rationale: decision.reasoning,
        // §7.3 (ATLAS_v4) — /classify and /recommend share the classifier
        // but use different selectors BY DESIGN. Surface the contract on
        // BOTH endpoints (recommend already has it) so it's never silent:
        // classify.recommended_model = strongest task-fit pick;
        // recommend.recommendations[0] = best cost/quality. Legitimately
        // differ — choose per need.
        selector_note:
            'recommended_model = strongest task-fit pick (preferredFor[task]). For the cheapest viable model call /v1/recommend and take recommendations[0]; the two selectors differ by design.',
        latency_ms,
        // §7.2 (ATLAS_v4) — the legacy `tier` key (always null for keys
        // without a plan, and conflated with model capability tier) is
        // REMOVED. `model_tier` above is the single source of truth for
        // the recommended model's capability tier. Account/plan tier is
        // not part of a classification result and belongs on /resolve.
    });
});
export default app;
