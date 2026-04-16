import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { storeMemory } from '$lib/server/engine';

export const POST: RequestHandler = async ({ request }) => {
  const { content, userId = 'default', tags = [] } = await request.json();
  if (!content) return json({ error: 'content required' }, { status: 400 });

  const result = await storeMemory(content, userId, tags);
  return json(result);
};
