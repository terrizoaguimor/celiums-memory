import type { RequestHandler } from './$types';

const ENGINE = process.env.ENGINE_URL || 'http://localhost:3210';

export const GET: RequestHandler = async ({ url }) => {
  const params = url.searchParams.toString();
  const res = await fetch(`${ENGINE}/oauth/authorize?${params}`);
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/html' },
  });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  const res = await fetch(`${ENGINE}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });

  // Forward redirect
  if (res.status === 302 || res.status === 301) {
    return new Response(null, {
      status: res.status,
      headers: { Location: res.headers.get('Location') || '/' },
    });
  }

  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/html' },
  });
};
