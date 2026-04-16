import type { RequestHandler } from './$types';

const ENGINE = process.env.ENGINE_URL || 'http://localhost:3210';

export const GET: RequestHandler = async () => {
  try {
    const res = await fetch(`${ENGINE}/health`);
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ status: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
