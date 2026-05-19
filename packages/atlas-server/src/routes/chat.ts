// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * POST /v1/chat/completions  — OpenAI-compatible wrapper in front of the Smart Router.
 *
 * Flow:
 *   1. Parse and validate the body (messages, tools, stream).
 *   2. Classify → pick a model.
 *   3. Forward to inference.do-ai.run with model rewritten; stream back bytes.
 *   4. Record the decision (fire-and-forget).
 */
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { randomUUID, createHash } from 'node:crypto';
import { classify } from '../lib/classifier.js';
import { augmentMessages, augmentMessagesForRoute } from '../lib/prompt-library.js';
import { availableChatModels, availableModels, modelById } from '../lib/registry.js';
import { forward, pickFallbacks } from '../lib/forwarder.js';
import { recordDecision } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';
import { reportConsumption } from '../lib/usage-client.js';
import { classifyViaDispatcher, invokeRouter, dispatcherEnabled } from '../lib/dispatcher-client.js';
const app = new Hono();
function getFleetKey(c) {
    const auth = c.req.header('authorization');
    if (auth && auth.startsWith('Bearer '))
        return auth.slice(7);
    return process.env.CELIUMS_FLEET_KEY || null;
}
// Models that count as a "frontier escape" against tier quota.
const FRONTIER_ESCAPE_RE = /(opus|gpt-5\.4-pro|gpt-5\.2-pro|gpt-5\.3-codex|gpt-5\.1-codex-max|sonnet|^openai-o[13])/i;
// Best-effort SSE usage extractor: scans an OpenAI-compatible stream's
// trailing `data: {...}` chunks for the `usage` field that DO Inference
// emits when `stream_options.include_usage` is true. Returns {in, out} or
// {in:0, out:0} if not found. Cheap regex pass — no JSON parse storm.
function extractUsageFromSse(buf: string): { in: number; out: number } {
    // Walk backwards line by line so we hit the final usage block fast.
    const lines = buf.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || payload === '') continue;
        try {
            const obj = JSON.parse(payload);
            if (obj && obj.usage) {
                return {
                    in: Number(obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? 0),
                    out: Number(obj.usage.completion_tokens ?? obj.usage.output_tokens ?? 0),
                };
            }
        } catch {
            // ignore malformed line
        }
    }
    return { in: 0, out: 0 };
}
function hashMessages(messages) {
    const h = createHash('sha256');
    for (const m of messages) {
        h.update(m.role);
        h.update('|');
        h.update(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        h.update('\n');
    }
    return h.digest('hex');
}
function firstUserTextPreview(messages) {
    const u = [...messages].reverse().find((m) => m.role === 'user');
    if (!u)
        return '';
    const t = typeof u.content === 'string' ? u.content : JSON.stringify(u.content);
    return t.slice(0, 200);
}
/**
 * Dispatcher path — fires when ATLAS_USE_DISPATCHER=true and the caller
 * didn't pin a model. Returns the final HTTP response (so chat.ts can
 * `return` it) or null if the dispatcher classification failed, in which
 * case the caller falls through to the legacy classify+forward path.
 *
 * Preserves the same observability hooks the legacy path uses:
 * recordDecision, reportConsumption, response headers. The `classifier_json`
 * field in recordDecision holds the dispatcher's {route, confidence, reason}
 * so we can audit misrouting after the fact.
 */
async function runDispatcherPath(ctx: {
    c: any;
    body: any;
    requestId: string;
    t0: number;
    fleetKey: string;
    auth: any;
    allowedModels: string[] | undefined;
    promptHash: string;
    promptPreview: string;
}) {
    const { c, body, requestId, t0, fleetKey, auth, allowedModels, promptHash, promptPreview } = ctx;

    const abort = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => abort.abort());

    // Step 1: classify
    const decision = await classifyViaDispatcher(body.messages, fleetKey, abort.signal);
    if (!decision) return null;   // fallthrough to legacy

    // Step 1b: prompt augmentation (Atlas killer feature) on the dispatcher
    // path. classifyViaDispatcher only yields a thematic route, so augment by
    // route. No-ops if a caller system message exists or augment:false.
    if (body.augment !== false) {
        body.messages = augmentMessagesForRoute(body.messages, decision.route);
    }

    // Step 2: invoke downstream router with the (possibly augmented) body
    const invocation = await invokeRouter(decision.route, body, fleetKey, abort.signal);

    // Standard observability headers
    c.header('x-celiums-atlas-task', decision.selectedRoute ?? decision.route);
    c.header('x-celiums-atlas-from', 'dispatcher');
    c.header('x-celiums-atlas-request-id', requestId);
    c.header('x-celiums-dispatcher-route', decision.route);
    c.header('x-celiums-dispatcher-confidence', String(decision.confidence));
    // OSS #174 B2: no paid tiers — no tier headers.

    const userId = c.req.header('x-celiums-user-id') ?? null;
    const tenantId = c.req.header('x-celiums-tenant-id') ?? null;
    const isStream = body.stream === true;

    if (!isStream) {
        const data = await invocation.response.json().catch(() => null);
        const latency = Math.round(performance.now() - t0);
        const usage = data?.usage ?? {};
        const modelUsed = data?.model ?? '(unknown)';
        const outcome = invocation.response.ok ? 'success' : 'error';
        const tokensIn = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
        const tokensOut = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
        const isEscape = FRONTIER_ESCAPE_RE.test(modelUsed);

        c.header('x-celiums-atlas-model', modelUsed);

        // OSS #174 B2: no paid tiers — the router's model choice is final
        // (no tier-bound model gating).

        void recordDecision({
            request_id: requestId,
            user_id: userId,
            tenant_id: tenantId,
            prompt_hash: promptHash,
            prompt_preview: promptPreview,
            classifier_json: decision as any,
            model_chosen: modelUsed,
            fallback_chain: null,
            input_tokens: tokensIn || null,
            output_tokens: tokensOut || null,
            tool_calls: 0,
            latency_ms: latency,
            outcome,
            error_kind: outcome === 'error' ? String(invocation.response.status) : null,
        });

        if (auth.mode === 'user' && auth.apiKey && outcome === 'success') {
            void reportConsumption({
                apiKey: auth.apiKey,
                model: modelUsed,
                tokensIn,
                tokensOut,
                escapes: isEscape ? 1 : 0,
            });
        }
        return c.json(data, invocation.response.status as 200 | 400 | 401 | 403 | 404 | 500 | 502 | 503);
    }

    // Streaming path: pipe upstream bytes, scrape usage + model from the
    // final SSE chunks. Mirrors the legacy streaming branch.
    return stream(c, async (s: any) => {
        if (!invocation.response.body) {
            s.write('data: {"error":"no upstream body"}\n\n');
            return;
        }
        const reader = invocation.response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let totalChars = 0;
        let tail = '';
        const TAIL_MAX = 8192;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) {
                    totalChars += value.byteLength;
                    await s.write(value);
                    const txt = decoder.decode(value, { stream: true });
                    tail = (tail + txt).slice(-TAIL_MAX);
                }
            }
        } catch (e) {
            console.error('[celiums-atlas:dispatcher] stream interrupted:', (e as Error).message);
        } finally {
            const latency = Math.round(performance.now() - t0);
            const usage = extractUsageFromSse(tail);
            // Try to recover the model from the SSE tail too (first SSE chunk
            // usually has `"model":"..."`).
            let modelUsed = '(unknown)';
            const modelMatch = tail.match(/"model"\s*:\s*"([^"]+)"/);
            if (modelMatch) modelUsed = modelMatch[1];

            const outputTokens = usage.out > 0 ? usage.out : Math.ceil(totalChars / 4);
            const inputTokens = usage.in > 0 ? usage.in : 0;
            const isEscape = FRONTIER_ESCAPE_RE.test(modelUsed);

            void recordDecision({
                request_id: requestId,
                user_id: userId,
                tenant_id: tenantId,
                prompt_hash: promptHash,
                prompt_preview: promptPreview,
                classifier_json: decision as any,
                model_chosen: modelUsed,
                fallback_chain: null,
                input_tokens: inputTokens || null,
                output_tokens: outputTokens,
                tool_calls: 0,
                latency_ms: latency,
                outcome: invocation.response.ok ? 'success' : 'error',
                error_kind: invocation.response.ok ? null : String(invocation.response.status),
            });

            if (auth.mode === 'user' && auth.apiKey && invocation.response.ok) {
                void reportConsumption({
                    apiKey: auth.apiKey,
                    model: modelUsed,
                    tokensIn: inputTokens,
                    tokensOut: outputTokens,
                    escapes: isEscape ? 1 : 0,
                });
            }
        }
    });
}

app.post('/v1/chat/completions', async (c) => {
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
    let body;
    try {
        body = await c.req.json();
    }
    catch {
        return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request' } }, 400);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return c.json({ error: { message: 'messages[] required', type: 'invalid_request' } }, 400);
    }
    // OSS #174 B2: no paid tiers — no tier-bound model pool, and a pinned
    // model is honored as-is (no tier gating).
    const allowedModels: string[] | undefined = undefined as string[] | undefined;
    const requestedModel = typeof body.model === 'string' && body.model !== 'celiums-smart' ? body.model : undefined;

    // ─── DISPATCHER PATH (feature-flagged via ATLAS_USE_DISPATCHER) ────────
    // When enabled, delegate classification + routing to DigitalOcean
    // Inference Router. The dispatcher router returns a downstream router
    // label; we then re-invoke with router:<label> and the downstream
    // router internally picks the sub-task + model.
    //
    // We skip the dispatcher when the caller pinned an explicit model
    // (requestedModel) — that's a manual override that should bypass any
    // routing logic entirely.
    if (dispatcherEnabled() && !requestedModel) {
        const dispatcherResult = await runDispatcherPath({
            c, body, requestId, t0,
            fleetKey, auth, allowedModels,
            promptHash: hashMessages(body.messages),
            promptPreview: firstUserTextPreview(body.messages),
        });
        if (dispatcherResult) return dispatcherResult;
        // null = dispatcher classification failed → fall through to legacy
        // classifier+forwarder path below. Logged inside the helper.
    }

    const decision = await classify({ messages: body.messages, tools: body.tools, tool_choice: body.tool_choice, stream: body.stream, requestedModel }, { fleetKey, allowedModels });
    const chosen = modelById(decision.model_id);
    if (!chosen) {
        return c.json({ error: { message: `unknown model ${decision.model_id}`, type: 'internal_error' } }, 500);
    }
    // 1b. Prompt augmentation (Atlas killer feature). Only when Atlas
    //     auto-routes (no pinned model) and the caller did not pass their
    //     own system message — augmentMessages internally no-ops if a
    //     system message is already present. Opt out with `augment:false`.
    if (!requestedModel && body.augment !== false) {
        body.messages = augmentMessages(body.messages, decision.task);
    }
    // 2. Build fallback chain — restricted to tier's allowed_models when set.
    const allowedSet = allowedModels && allowedModels.length > 0 ? new Set(allowedModels) : null;
    const ga = availableChatModels(false).filter((m) => allowedSet === null || allowedSet.has(m.id));
    const fallbacks = pickFallbacks(chosen, ga);
    // 3. Forward
    const abort = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => abort.abort());
    const result = await forward({ originalBody: body, chosen, fallbacks, fleetKey }, abort.signal);
    // Record header for observability
    c.header('x-celiums-atlas-task', decision.task);
    c.header('x-celiums-atlas-model', result.modelUsed);
    c.header('x-celiums-atlas-from', decision.from);
    c.header('x-celiums-atlas-request-id', requestId);
    // OSS #174 B2: no paid tiers — no tier headers.
    const promptHash = hashMessages(body.messages);
    const promptPreview = firstUserTextPreview(body.messages);
    const userId = c.req.header('x-celiums-user-id') ?? null;
    const tenantId = c.req.header('x-celiums-tenant-id') ?? null;
    const isEscape = FRONTIER_ESCAPE_RE.test(result.modelUsed);
    // 4. Stream OR buffer + record
    const isStream = body.stream === true;
    if (!isStream) {
        // Non-streaming: buffer, parse, record, return
        const data = await result.response.json().catch(() => null);
        const latency = Math.round(performance.now() - t0);
        const usage = data?.usage ?? {};
        const outcome = result.response.ok ? 'success' : 'error';
        const tokensIn = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
        const tokensOut = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
        void recordDecision({
            request_id: requestId,
            user_id: userId,
            tenant_id: tenantId,
            prompt_hash: promptHash,
            prompt_preview: promptPreview,
            classifier_json: decision,
            model_chosen: result.modelUsed,
            fallback_chain: result.fallbackChain.length > 1 ? result.fallbackChain : null,
            input_tokens: tokensIn || null,
            output_tokens: tokensOut || null,
            tool_calls: 0,
            latency_ms: latency,
            outcome,
            error_kind: outcome === 'error' ? String(result.response.status) : null,
        });
        // Tier consumption — fire-and-forget. Only for user keys with successful upstream responses.
        if (auth.mode === 'user' && auth.apiKey && outcome === 'success') {
            void reportConsumption({
                apiKey: auth.apiKey,
                model: result.modelUsed,
                tokensIn,
                tokensOut,
                escapes: isEscape ? 1 : 0,
            });
        }
        return c.json(data, result.response.status as 200 | 400 | 401 | 403 | 404 | 500 | 502 | 503);
    }
    // Streaming: pipe upstream bytes, scrape usage from final SSE chunks.
    return stream(c, async (s) => {
        if (!result.response.body) {
            s.write('data: {"error":"no upstream body"}\n\n');
            return;
        }
        const reader = result.response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let totalChars = 0;
        // Keep only the trailing window in memory — usage block lives near [DONE], so 8KB is plenty.
        let tail = '';
        const TAIL_MAX = 8192;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                if (value) {
                    totalChars += value.byteLength;
                    await s.write(value);
                    const txt = decoder.decode(value, { stream: true });
                    tail = (tail + txt).slice(-TAIL_MAX);
                }
            }
        }
        catch (e) {
            console.error('[celiums-atlas] stream interrupted:', (e as Error).message);
        }
        finally {
            const latency = Math.round(performance.now() - t0);
            const usage = extractUsageFromSse(tail);
            // Fall back to crude byte-rate approximation only when the upstream
            // didn't include usage (e.g., client didn't ask for stream_options).
            const outputTokens = usage.out > 0 ? usage.out : Math.ceil(totalChars / 4);
            const inputTokens = usage.in > 0 ? usage.in : 0;
            void recordDecision({
                request_id: requestId,
                user_id: userId,
                tenant_id: tenantId,
                prompt_hash: promptHash,
                prompt_preview: promptPreview,
                classifier_json: decision,
                model_chosen: result.modelUsed,
                fallback_chain: result.fallbackChain.length > 1 ? result.fallbackChain : null,
                input_tokens: inputTokens || null,
                output_tokens: outputTokens,
                tool_calls: 0,
                latency_ms: latency,
                outcome: result.response.ok ? 'success' : 'error',
                error_kind: result.response.ok ? null : String(result.response.status),
            });
            if (auth.mode === 'user' && auth.apiKey && result.response.ok) {
                void reportConsumption({
                    apiKey: auth.apiKey,
                    model: result.modelUsed,
                    tokensIn: inputTokens,
                    tokensOut: outputTokens,
                    escapes: isEscape ? 1 : 0,
                });
            }
        }
    });
});
// Pass-through: embeddings. The router doesn't classify these (single
// expected model), just forwards to DO inference to keep a single
// base URL for CLI clients.
app.post('/v1/embeddings', async (c) => {
    const fleetKey = getFleetKey(c);
    if (!fleetKey) {
        return c.json({ error: { message: 'missing Authorization', type: 'auth_error' } }, 401);
    }
    const body = await c.req.text();
    const upstream = process.env.INFERENCE_URL || 'https://inference.do-ai.run';
    const res = await fetch(`${upstream}/v1/embeddings`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${fleetKey}`,
            'Content-Type': 'application/json',
        },
        body,
    });
    c.status(res.status as 200 | 400 | 401 | 403 | 404 | 500 | 502 | 503);
    const out = await res.text();
    c.header('content-type', res.headers.get('content-type') ?? 'application/json');
    return c.body(out);
});
// Simple pass-through for /v1/models (same list as upstream)
app.get('/v1/models', (c) => {
    const data = availableModels(false).map((m) => ({
        id: m.id,
        object: 'model',
        family: m.family,
        tier: m.tier,
        context_length: m.longContext ? 128000 : 32000,
        tool_calling: m.toolCalling,
        vision: m.vision,
    }));
    return c.json({ object: 'list', data });
});
export default app;
