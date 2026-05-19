// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Forwarder — takes the classifier's decision + the caller's original body,
 * rewrites the `model` field to the chosen id, adjusts max_completion_tokens
 * to satisfy thinking models' minimums, and streams the upstream response
 * back. If the chosen model fails hard (5xx), we cascade through a fallback
 * chain before surfacing the error.
 */
const INFERENCE_URL = process.env.INFERENCE_URL || 'https://inference.do-ai.run';
/**
 * Flatten tool_calls / role=tool messages into plain text before handing the
 * conversation to a model that can't parse them. Without this the classifier
 * can route turn N to a tool-capable model (Claude, Sonnet) that emits
 * assistant.tool_calls, then turn N+1 to a smaller / OSS / non-tool model
 * which silently drops or misinterprets those fields — and the assistant
 * loses the thread ("¿a qué te refieres con Option A?" right after the user
 * said "Option A"). Converting to prose preserves semantic continuity.
 */
function flattenToolTraffic(messages) {
    return messages.map((m) => {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const calls = m.tool_calls.map((tc) => {
                const name = tc.function?.name ?? 'tool';
                const args = tc.function?.arguments ?? '';
                return `• called ${name}(${args.slice(0, 400)})`;
            }).join('\n');
            const existing = typeof m.content === 'string' ? m.content : '';
            const next = {
                role: 'assistant',
                content: existing ? `${existing}\n\n[tool calls]\n${calls}` : `[tool calls]\n${calls}`,
            };
            return next;
        }
        if (m.role === 'tool') {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
            const label = m.name ?? m.tool_call_id ?? 'tool';
            return { role: 'user', content: `[tool result — ${label}]\n${text}` };
        }
        return m;
    });
}
function rewriteBody(body, model) {
    const out = { ...body };
    out.model = model.id;
    const requested = Number((out.max_completion_tokens ?? out.max_tokens) ?? 0);
    if (!requested || requested < model.minMaxTokens) {
        out.max_completion_tokens = model.minMaxTokens;
        delete out.max_tokens;
    }
    // Models without tool_calling shouldn't receive tools — strip them
    if (!model.toolCalling) {
        delete out.tools;
        delete out.tool_choice;
        if (Array.isArray(out.messages)) {
            out.messages = flattenToolTraffic(out.messages);
        }
    }
    return out;
}
async function callUpstream(body, fleetKey, signal) {
    return fetch(`${INFERENCE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${fleetKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
    });
}
/** Cascade through chosen + fallbacks until one returns 2xx or 4xx (4xx is final — caller's fault). */
export async function forward(input, signal) {
    const candidates = [input.chosen, ...input.fallbacks];
    const chain: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i];
        const body = rewriteBody(input.originalBody, model);
        const res = await callUpstream(body, input.fleetKey, signal);
        chain.push(model.id);
        if (res.ok) {
            return { response: res, modelUsed: model.id, fallbackChain: chain };
        }
        // 4xx → bubble up, it's the caller's fault (bad request)
        if (res.status >= 400 && res.status < 500) {
            return { response: res, modelUsed: model.id, fallbackChain: chain };
        }
        // 5xx or 429 → try next candidate
        const bodyText = await res.text().catch(() => '');
        console.warn(`[celiums-atlas] forwarder ${model.id} returned ${res.status} (${bodyText.slice(0, 120)}), falling back`);
    }
    // All candidates exhausted
    return {
        response: new Response(JSON.stringify({ error: { message: 'all models unavailable', type: 'service_unavailable' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
        modelUsed: candidates[0]?.id ?? 'unknown',
        fallbackChain: chain,
    };
}
/** Given the chosen model, pick 2 sensible fallbacks (same family OR workhorse alternatives).
 *  Restricts to category==='chat' so embed/image/tts/video catalog entries never enter
 *  a chat-completion fallback chain. */
export function pickFallbacks(chosen, allAvailable) {
    // chat-only candidates other than the chosen one
    const others = allAvailable.filter((m) => m.id !== chosen.id && m.category === 'chat');
    // 1. Another chat model in the same family and tier
    const sameFamily = others.find((m) => m.family === chosen.family && m.tier === chosen.tier);
    // 2. OSS workhorse — always a safe last resort
    const ossWorkhorse = others.find((m) => m.id === 'openai-gpt-oss-120b');
    return [sameFamily, ossWorkhorse].filter((m) => !!m && m.id !== chosen.id);
}
