import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { storeMemory } from '$lib/server/engine';

export const POST: RequestHandler = async ({ request }) => {
  const backup = await request.json();

  if (!backup.memories || !Array.isArray(backup.memories)) {
    return json({ error: 'Invalid backup format' }, { status: 400 });
  }

  let count = 0;
  for (const mem of backup.memories) {
    if (!mem.content) continue;
    try {
      await storeMemory(mem.content, 'default', mem.tags || []);
      count++;
    } catch {
      // Skip failed memories, continue with rest
    }
  }

  return json({ count, total: backup.memories.length });
};
