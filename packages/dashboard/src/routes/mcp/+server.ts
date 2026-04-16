import type { RequestHandler } from './$types';

const ENGINE = process.env.ENGINE_URL || 'http://localhost:3210';
const ENGINE_KEY = process.env.ENGINE_KEY || '';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  let parsed: any;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }

  const method = parsed.method || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = request.headers.get('Authorization');

  // Discovery is public — initialize, tools/list, ping
  const isDiscovery = ['initialize', 'tools/list', 'ping', 'notifications/initialized'].includes(method);

  if (auth) {
    // Client sent auth (from Claude.ai Client Secret or direct Bearer)
    // Forward to engine — engine validates
    headers['Authorization'] = auth;
  } else if (isDiscovery) {
    // Public discovery — use engine key internally
    headers['Authorization'] = `Bearer ${ENGINE_KEY}`;
  } else {
    // No auth on execution — reject
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: parsed.id ?? null,
      error: { code: -32001, message: 'Authentication required. Set your API key as OAuth Client Secret in your connector settings.' },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
    });
  }

  const sessionId = request.headers.get('mcp-session-id');
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(`${ENGINE}/mcp`, { method: 'POST', headers, body });

  const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const resSessionId = res.headers.get('mcp-session-id');
  if (resSessionId) responseHeaders['Mcp-Session-Id'] = resSessionId;

  return new Response(await res.text(), { status: res.status, headers: responseHeaders });
};

export const GET: RequestHandler = async ({ request }) => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(': connected\n\n'));
      const keepAlive = setInterval(() => {
        try { controller.enqueue(enc.encode(': ping\n\n')); }
        catch { clearInterval(keepAlive); }
      }, 15000);
      request.signal.addEventListener('abort', () => { clearInterval(keepAlive); controller.close(); });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
};

export const DELETE: RequestHandler = async () => new Response(null, { status: 200 });
