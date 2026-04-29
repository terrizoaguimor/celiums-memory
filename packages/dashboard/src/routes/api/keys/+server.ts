/**
 * BYOK key vault HTTP API.
 *
 * GET    /api/keys                    list redacted entries
 * POST   /api/keys                    upsert entry { provider, label?, value, baseUrl?, model? }
 * DELETE /api/keys?provider&label?    remove entry
 *
 * Plaintext values are NEVER returned. The dashboard shows last 4 chars only.
 */

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listKeys, setKey, deleteKey } from '$lib/server/keyvault';

function requireAuth(locals: App.Locals) {
  if (!locals.user) throw error(401, 'unauthorized');
}

export const GET: RequestHandler = async ({ locals }) => {
  requireAuth(locals);
  const keys = await listKeys();
  return json({ keys });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  requireAuth(locals);
  const body = await request.json().catch(() => ({}));
  const { provider, label, value, model } = body as Record<string, string | undefined>;
  if (!provider || !value) throw error(400, 'provider and value are required');
  if (value.length < 4) throw error(400, 'value too short to be a valid key');
  // baseUrl is intentionally NOT accepted from the client — it's pinned per
  // provider in the @celiums/memory catalog.
  const entry = await setKey({ provider, label, value, model });
  return json({ key: entry });
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
  requireAuth(locals);
  const provider = url.searchParams.get('provider') ?? '';
  const label = url.searchParams.get('label') ?? undefined;
  if (!provider) throw error(400, 'provider query param required');
  const removed = await deleteKey(provider, label);
  if (!removed) throw error(404, 'entry not found');
  return json({ ok: true });
};
