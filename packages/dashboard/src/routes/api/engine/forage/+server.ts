import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forageModules } from '$lib/server/engine';

export const GET: RequestHandler = async ({ url }) => {
  const query = url.searchParams.get('q') || '';
  const limit = parseInt(url.searchParams.get('limit') || '24');
  if (!query) return json({ modules: [] });

  const result = await forageModules(query, limit);
  return json({ modules: result.modules || result.results || [] });
};
