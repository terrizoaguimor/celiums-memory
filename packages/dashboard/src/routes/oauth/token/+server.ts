import type { RequestHandler } from './$types';

const ENGINE = process.env.ENGINE_URL || 'http://localhost:3210';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  const res = await fetch(`${ENGINE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
    body,
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
