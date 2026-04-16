import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recallMemories } from '$lib/server/engine';

export const POST: RequestHandler = async ({ request }) => {
  const { query, userId = 'default' } = await request.json();
  if (!query) return json({ error: 'query required' }, { status: 400 });

  const result = await recallMemories(query, userId);
  return json(result);
};
