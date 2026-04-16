import type { RequestHandler } from './$types';
import { recallMemories } from '$lib/server/engine';

export const POST: RequestHandler = async () => {
  // Recall ALL memories (broad query)
  const result = await recallMemories('*', 'default');
  const memories = result.memories || [];

  const backup = {
    version: '1.0',
    engine: 'celiums-memory',
    exported_at: new Date().toISOString(),
    count: memories.length,
    memories: memories.map((m: any) => ({
      content: m.content || m.memory?.content,
      type: m.type || m.memory?.memoryType,
      importance: m.importance || m.memory?.importance,
      tags: m.tags || m.memory?.tags || [],
      created_at: m.created_at || m.memory?.createdAt,
    })),
  };

  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="celiums-backup-${new Date().toISOString().split('T')[0]}.json"`,
    },
  });
};
