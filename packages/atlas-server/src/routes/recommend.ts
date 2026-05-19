// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * POST /v1/recommend — recommend models for a task description with optional
 * hard constraints (cost ceiling, capability flags). Unlike /v1/classify which
 * picks one model, this returns a ranked list so the caller can choose.
 *
 * Pipeline:
 *   1. classify(task_description) → task_type
 *   2. filter registry by constraints (cost, tools, vision, long_context)
 *   3. score each candidate: 0.6 × capability_match + 0.4 × (1 / cost_norm)
 *      - capability_match: tier alignment with task_type + matching capability
 *        flags (each flag the user requested gets credit if model has it).
 *      - cost_norm: blended (in+out)/1M usd, normalized to the max cost in
 *        the candidate set so the cheapest model gets the largest cost-bonus.
 *   4. return top-5 ranked.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { classify } from '../lib/classifier.js';
import { availableChatModels } from '../lib/registry.js';
import { authenticate } from '../lib/auth.js';
const app = new Hono();
const RecommendBody = z.object({
    task_description: z.string().min(1).max(8000),
    constraints: z
        .object({
        max_cost_per_1k_in_usd: z.number().nonnegative().optional(),
        requires_tools: z.boolean().optional(),
        requires_vision: z.boolean().optional(),
        requires_long_context: z.boolean().optional(),
    })
        .optional(),
});
function getFleetKey(c) {
    const auth = c.req.header('authorization');
    if (auth && auth.startsWith('Bearer '))
        return auth.slice(7);
    return process.env.CELIUMS_FLEET_KEY || null;
}
/** Map a classifier task type to the tiers that are typically a good fit. */
function preferredTiers(task) {
    switch (task) {
        case 'architecture':
        case 'debug-complex':
        case 'reasoning':
            return ['premium', 'pro-thinking'];
        case 'code-generation':
        case 'code-review':
        case 'tool-use':
            return ['workhorse', 'pro-thinking', 'premium'];
        case 'code-edit-small':
        case 'documentation':
        case 'chat':
            return ['workhorse', 'fast'];
        case 'fast-completion':
            return ['fast', 'bulk'];
        case 'vision':
            return ['workhorse', 'premium', 'fast'];
        default:
            return ['workhorse'];
    }
}
app.post('/v1/recommend', async (c) => {
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
    const parsed = RecommendBody.safeParse(raw);
    if (!parsed.success) {
        return c.json({ error: { message: parsed.error.message, type: 'invalid_request' } }, 400);
    }
    const { task_description, constraints = {} } = parsed.data;
    // OSS #174 B2: no paid tiers — no tier-bound model pool.
    const allowedModels: string[] | undefined = undefined as string[] | undefined;
    const messages = [{ role: 'user', content: task_description }];
    const decision = await classify({ messages }, { fleetKey, allowedModels });
    const task_type = decision.task;
    const tierPrefs = preferredTiers(task_type);
    // 2. Filter by hard constraints AND tier's allowed_models when set.
    const allowedSet = allowedModels && allowedModels.length > 0 ? new Set(allowedModels) : null;
    const ga = availableChatModels(false).filter((m) => allowedSet === null || allowedSet.has(m.id));
    const candidates = ga.filter((m) => {
        if (constraints.requires_tools && !m.toolCalling)
            return false;
        if (constraints.requires_vision && !m.vision)
            return false;
        if (constraints.requires_long_context && !m.longContext)
            return false;
        if (constraints.max_cost_per_1k_in_usd != null) {
            const blendedPer1k = (m.inputPer1M + m.outputPer1M) / 1000;
            if (blendedPer1k > constraints.max_cost_per_1k_in_usd)
                return false;
        }
        return true;
    });
    if (candidates.length === 0) {
        return c.json({ task_type, recommendations: [] });
    }
    // 3. Score each candidate.
    const maxBlendedCost = Math.max(...candidates.map((m) => m.inputPer1M + m.outputPer1M), 0.001);
    const scored = candidates.map((m) => {
        const blended = m.inputPer1M + m.outputPer1M;
        // costNorm in [0,1]: 1 = cheapest in the set, 0 = most expensive.
        const costNorm = 1 - blended / maxBlendedCost;
        // capabilityMatch in [0,1]:
        //   +0.5 if tier is the top preference for the task,
        //   +0.3 if tier is in the secondary list,
        //   +0.05 per matching capability flag (tools/vision/long_context).
        let capabilityMatch = 0;
        if (tierPrefs[0] === m.tier)
            capabilityMatch += 0.5;
        else if (tierPrefs.includes(m.tier))
            capabilityMatch += 0.3;
        if (constraints.requires_tools && m.toolCalling)
            capabilityMatch += 0.05;
        if (constraints.requires_vision && m.vision)
            capabilityMatch += 0.05;
        if (constraints.requires_long_context && m.longContext)
            capabilityMatch += 0.05;
        capabilityMatch = Math.min(capabilityMatch, 1);
        const score = capabilityMatch * 0.6 + costNorm * 0.4;
        const reasonBits: string[] = [];
        if (tierPrefs[0] === m.tier)
            reasonBits.push(`top-tier match for ${task_type}`);
        else if (tierPrefs.includes(m.tier))
            reasonBits.push(`secondary-tier match for ${task_type}`);
        else
            reasonBits.push(`off-tier for ${task_type}`);
        reasonBits.push(`blended cost $${blended.toFixed(2)}/1M`);
        if (constraints.requires_tools && m.toolCalling)
            reasonBits.push('tool-calling ok');
        if (constraints.requires_vision && m.vision)
            reasonBits.push('vision ok');
        if (constraints.requires_long_context && m.longContext)
            reasonBits.push('long-context ok');
        return {
            model: m,
            score,
            capabilityMatch,
            costNorm,
            rationale: reasonBits.join('; '),
        };
    });
    scored.sort((a, b) => b.score - a.score);
    return c.json({
        task_type,
        // §7.7 — /classify and /recommend share the classifier but use
        // different selectors BY DESIGN: classify = best task-fit pick
        // (strongest in preferredFor[task]); recommend = cost/quality
        // ranked frontier. Surface classify's pick explicitly so the
        // divergence is documented in the payload, not silent.
        classify_pick: decision.model_id,
        selector_note:
            'classify_pick = strongest task-fit model; recommendations[0] = best cost/quality. They legitimately differ; pick per your need.',
        recommendations: scored.slice(0, 5).map((s) => ({
            model_id: s.model.id,
            score: Number(s.score.toFixed(4)),
            rationale: s.rationale,
            est_cost_per_1k_in_usd: Number((s.model.inputPer1M / 1000).toFixed(6)),
            est_cost_per_1k_out_usd: Number((s.model.outputPer1M / 1000).toFixed(6)),
        })),
    });
});
export default app;
