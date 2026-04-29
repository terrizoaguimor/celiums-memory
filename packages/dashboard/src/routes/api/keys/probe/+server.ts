/**
 * BYOK key probe.
 *
 * Validates a freshly-pasted API key against its provider by calling
 * `${provider.baseUrl}/models` server-side and returns the model list.
 * Doing it server-side avoids CORS for OpenAI / Anthropic / DO / etc.,
 * and the value never leaves this Node process — we reject keys that
 * don't authenticate before we ever encrypt them.
 *
 * The plaintext value is held in memory only for the duration of the
 * probe request and is NOT persisted unless the user separately calls
 * POST /api/keys to save it.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PROVIDERS } from '@celiums/memory';

interface ProbeBody {
  provider?: string;
  value?: string;
}

interface ModelInfo {
  id: string;
  context?: number;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'unauthorized');

  const body = (await request.json().catch(() => ({}))) as ProbeBody;
  const { provider, value } = body;
  if (!provider || !value) throw error(400, 'provider and value are required');
  if (value.length < 4) throw error(400, 'value too short');

  const def = PROVIDERS.find((p) => p.id === provider);
  if (!def) throw error(400, 'unknown provider');

  const url = `${def.baseUrl.replace(/\/+$/, '')}/models`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${value}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return json(
      { ok: false, status: 0, error: 'Could not reach provider — check network or the key.' },
      { status: 200 },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return json({ ok: false, status: response.status, error: 'Provider rejected the key.' }, { status: 200 });
  }
  if (!response.ok) {
    return json({ ok: false, status: response.status, error: `Provider returned ${response.status}.` }, { status: 200 });
  }

  // OpenAI-compatible /models response: { data: [{ id, ... }, ...] }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return json({ ok: false, status: response.status, error: 'Unexpected response from provider.' }, { status: 200 });
  }

  const list = (data as { data?: Array<{ id?: string; context_length?: number }> })?.data;
  if (!Array.isArray(list)) {
    return json({ ok: false, status: response.status, error: 'No model list returned.' }, { status: 200 });
  }

  const models: ModelInfo[] = list
    .filter((m): m is { id: string } => typeof m?.id === 'string')
    .map((m) => ({ id: m.id, context: (m as { context_length?: number }).context_length }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return json({
    ok: true,
    provider,
    models,
    defaultModel: def.defaultModel,
  });
};
