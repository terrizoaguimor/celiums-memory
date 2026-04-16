/**
 * Celiums Engine Client
 * Server-side only — talks to local celiums-memory engine via HTTP.
 */

const ENGINE_BASE = process.env.ENGINE_URL || 'http://localhost:3210';
const ENGINE_KEY = process.env.ENGINE_KEY || '';

interface FetchOptions {
  method?: string;
  body?: unknown;
}

async function engineFetch<T = any>(path: string, opts: FetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ENGINE_KEY) headers['Authorization'] = `Bearer ${ENGINE_KEY}`;

  const res = await fetch(`${ENGINE_BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`Engine ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

async function mcpCall(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await engineFetch('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
  });

  const text = res.result?.content?.[0]?.text;
  if (!text) return res.result;

  // Try JSON first
  try { return JSON.parse(text); }
  catch { /* not JSON — parse markdown */ }

  // Parse markdown module listings from forage/sense
  return { modules: parseModuleList(text), raw: text };
}

/**
 * Parse the markdown-formatted module list from forage/sense into structured data.
 * Format: "1. name-slug\n   Display Name\n   category: X | eval: Y\n   Description"
 */
function parseModuleList(text: string): Array<{
  name: string;
  display_name: string;
  category: string;
  description: string;
  eval: string;
}> {
  const modules: any[] = [];
  // Match patterns like: "name-slug\n   Display Name\n   category: X | eval: Y"
  // Or: "**Display Name** (`name-slug`)\n   category · eval"
  const lines = text.split('\n');

  let current: any = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Pattern 1: "1. name-slug" or numbered item
    const numMatch = line.match(/^\d+\.\s+(?:\*\*(.+?)\*\*\s*\(`?([^`\)]+)`?\)|([a-z0-9][\w-]+))/);
    if (numMatch) {
      if (current) modules.push(current);
      current = {
        name: numMatch[2] || numMatch[3] || '',
        display_name: numMatch[1] || '',
        category: '',
        description: '',
        eval: '',
      };
      continue;
    }

    if (!current) continue;

    // Display name line (indented, no prefix)
    if (!current.display_name && line && !line.startsWith('category') && !line.includes('eval:') && !line.startsWith('Found')) {
      current.display_name = line.replace(/^\*\*|\*\*$/g, '');
      continue;
    }

    // Category/eval line
    const catMatch = line.match(/category:\s*([^\s|·]+)/i);
    if (catMatch) {
      current.category = catMatch[1];
      const evalMatch = line.match(/eval:\s*([\d.?]+)/i);
      if (evalMatch) current.eval = evalMatch[1];
      continue;
    }

    // Category with · separator
    const dotMatch = line.match(/^([a-z-]+)\s*·\s*eval\s*([\d.?]+)?/i);
    if (dotMatch) {
      current.category = dotMatch[1];
      current.eval = dotMatch[2] || '';
      continue;
    }

    // Description (any remaining indented text)
    if (line && !line.startsWith('Load any') && !line.startsWith('Found') && !line.startsWith('Recommended')) {
      if (!current.description) current.description = line;
    }
  }

  if (current) modules.push(current);

  return modules;
}

// ── Public API ──────────────────────────────────────────────────

export async function getHealth() {
  try {
    return await engineFetch('/health');
  } catch {
    return { status: 'offline', mode: 'unknown', limbicState: null, knowledge: null };
  }
}

export async function getProfile(userId: string = 'default') {
  try {
    return await engineFetch(`/profile?userId=${userId}`);
  } catch {
    return null;
  }
}

export async function getEmotion(userId: string = 'default') {
  try {
    return await engineFetch(`/emotion?userId=${userId}`);
  } catch {
    return null;
  }
}

export async function storeMemory(content: string, userId: string = 'default', tags: string[] = []) {
  return mcpCall('remember', { content, userId, tags });
}

export async function recallMemories(query: string, userId: string = 'default') {
  return mcpCall('recall', { query, userId });
}

export async function forageModules(query: string, limit: number = 20) {
  return mcpCall('forage', { query, limit });
}

export async function senseModules(goal: string, limit: number = 20) {
  return mcpCall('sense', { goal, limit });
}

export async function absorbModule(name: string) {
  return mcpCall('absorb', { name });
}

export async function mapNetwork(category?: string) {
  return mcpCall('map_network', category ? { category } : {});
}
