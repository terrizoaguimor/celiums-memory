import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { hasUsers, validateSession } from '$lib/server/auth';

// Rate limiting for login
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();

export const handle: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname;

  // MCP/OAuth/health — public, no dashboard auth (auth handled by engine or OAuth flow)
  if (path.startsWith('/mcp') || path.startsWith('/oauth') || path.startsWith('/.well-known')
    || path === '/health') {
    return resolve(event);
  }

  // Setup and login — public but with rate limiting on login
  if (path.startsWith('/setup') || path.startsWith('/login')) {
    // Rate limit login POST
    if (path === '/login' && event.request.method === 'POST') {
      const ip = event.request.headers.get('cf-connecting-ip')
        || event.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || event.getClientAddress();
      const entry = loginAttempts.get(ip);
      if (entry && entry.blockedUntil > Date.now()) {
        return new Response('Too many login attempts. Try again later.', { status: 429 });
      }
    }
    // Wizard step routes (/setup/llm, /setup/welcome) need locals.user set
    // for the freshly-created admin to access their apiKey + scoped data.
    if (path.startsWith('/setup/')) {
      const token = event.cookies.get('celiums_session');
      if (token) {
        const session = validateSession(token);
        if (session) event.locals.user = session;
      }
    }
    return resolve(event);
  }

  // API routes — require session cookie (CRITICAL FIX: was previously open)
  if (path.startsWith('/api/')) {
    const token = event.cookies.get('celiums_session');
    if (!token || !validateSession(token)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return resolve(event);
  }

  // First-run: no user exists → force setup
  if (!hasUsers()) {
    if (path !== '/setup') redirect(302, '/setup');
    return resolve(event);
  }

  // Check session cookie
  const token = event.cookies.get('celiums_session');
  if (!token) redirect(302, '/login');

  const session = validateSession(token);
  if (!session) {
    event.cookies.delete('celiums_session', { path: '/' });
    redirect(302, '/login');
  }

  event.locals.user = session;
  return resolve(event);
};

// Track failed login attempts (called from login page.server.ts)
export function trackFailedLogin(ip: string): void {
  const entry = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= 5) {
    entry.blockedUntil = Date.now() + 60_000 * Math.pow(2, Math.min(entry.count - 5, 4)); // exponential backoff
  }
  loginAttempts.set(ip, entry);
}

export function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// Cleanup stale entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.blockedUntil < now && now - entry.blockedUntil > 600_000) loginAttempts.delete(ip);
  }
}, 600_000);
