#!/usr/bin/env node

const base = (process.env.CELIUMS_BENCH_HTTP_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const key = process.env.CELIUMS_BENCH_HTTP_KEY || 'bench-key';
const tenant = process.env.CELIUMS_BENCH_HTTP_TENANT || 'bench';

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${key}`,
    'x-celiums-tenant-id': tenant,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    ...extra,
  };
}

function elapsed(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function percentile(values, quantile) {
  return values[Math.round((values.length - 1) * quantile)];
}

const healthStarted = process.hrtime.bigint();
const health = await fetch(`${base}/healthz`);
const healthMs = elapsed(healthStarted);
if (!health.ok) throw new Error(`health HTTP ${health.status}`);

const initializeStarted = process.hrtime.bigint();
const initialize = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: headers(),
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'p10-http-baseline', version: '1' },
    },
  }),
});
const initializeMs = elapsed(initializeStarted);
if (!initialize.ok) throw new Error(`initialize HTTP ${initialize.status}`);
const sessionId = initialize.headers.get('mcp-session-id');
if (!sessionId) throw new Error('initialize did not return mcp-session-id');

const rememberMs = [];
for (let id = 2; id < 12; id++) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers({
      'MCP-Session-Id': sessionId,
      'MCP-Protocol-Version': '2025-11-25',
      'x-celiums-operation-id': `p10-http-${id}`,
    }),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: { content: `P10 HTTP baseline memory ${id}` },
      },
    }),
  });
  if (!response.ok) throw new Error(`remember HTTP ${response.status}`);
  rememberMs.push(elapsed(started));
}

rememberMs.sort((left, right) => left - right);
console.log(JSON.stringify({
  format: 1,
  transport: 'mcp-http',
  healthMs: Number(healthMs.toFixed(3)),
  initializeMs: Number(initializeMs.toFixed(3)),
  rememberP50Ms: Number(percentile(rememberMs, 0.5).toFixed(3)),
  rememberP90Ms: Number(percentile(rememberMs, 0.9).toFixed(3)),
  rememberMaxMs: Number(rememberMs.at(-1).toFixed(3)),
}));
