#!/usr/bin/env node
/**
 * Tiny redirect service — port 80 of the droplet's public IP.
 *
 * Reads /root/.celiums/dashboard_url (written by firstboot.sh after
 * cloudflared mints its *.trycloudflare.com URL) and 302-redirects
 * every incoming request there.
 *
 * Why: 1-Click Marketplace users see only the droplet's IPv4 in the
 * DO control panel. Without this hop they have to SSH in to find
 * out where their dashboard is reachable.
 *
 * Zero deps — Node's built-in http server only. ~50 lines.
 */

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';

const URL_FILE = process.env.CELIUMS_PUBLIC_URL_FILE ?? '/root/.celiums/dashboard_url';
const PORT = Number(process.env.PORT ?? 80);
const HOST = process.env.HOST ?? '0.0.0.0';

const NOT_READY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Celiums Memory — provisioning</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
         background: #050505; color: #fdf6e3; padding: 48px 24px;
         display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
  .card { max-width: 540px; border: 1px solid rgba(253,246,227,0.1); border-radius: 12px; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { color: rgba(253,246,227,0.6); line-height: 1.6; font-size: 14px; }
  code { background: rgba(253,246,227,0.05); padding: 2px 6px; border-radius: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b;
         display: inline-block; margin-right: 8px;
         animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
</style></head>
<body>
  <div class="card">
    <h1><span class="dot"></span>Provisioning</h1>
    <p>Celiums Memory is still booting on this droplet. The Cloudflare quick-tunnel hasn't published its URL yet — usually under 60 seconds from first boot.</p>
    <p>Refresh this page in a minute. If it persists, SSH in and run <code>journalctl -u celiums-tunnel -f</code> to see what cloudflared is doing.</p>
  </div>
</body></html>
`;

async function readPublicUrl() {
  try {
    const raw = await fs.readFile(URL_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('http://')) return null;
    return trimmed;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  // Health probe used by docker / DO health checks.
  if (req.url === '/__redirect_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive' }));
    return;
  }

  const target = await readPublicUrl();
  if (!target) {
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '15',
      'Cache-Control': 'no-store',
    });
    res.end(NOT_READY_HTML);
    return;
  }

  // Preserve path + query so /setup, /settings/keys, etc. work via the IP.
  const path = req.url ?? '/';
  res.writeHead(302, {
    Location: target.replace(/\/+$/, '') + path,
    'Cache-Control': 'no-store',
  });
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[celiums-redirect] listening on ${HOST}:${PORT}, source=${URL_FILE}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
