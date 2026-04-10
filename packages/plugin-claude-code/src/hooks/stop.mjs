#!/usr/bin/env node
/**
 * Stop hook.
 *
 * Runs when Claude finishes responding. Captures the final turn as a
 * memory so the system can learn from successful/unsuccessful patterns.
 */

import client from '../client.mjs';

async function main() {
  let stdin = '';
  try {
    for await (const chunk of process.stdin) stdin += chunk;
  } catch {}

  let payload = {};
  try {
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {
    process.exit(0);
  }

  // Claude Code may pass the assistant response in various formats
  const response = payload.response || payload.assistant_response || payload.stop_reason || '';

  if (!response || (typeof response === 'string' && response.length < 20)) {
    process.exit(0);
  }

  // Extract a concise summary — first 500 chars
  const summary = typeof response === 'string'
    ? response.substring(0, 500)
    : JSON.stringify(response).substring(0, 500);

  await client.store({
    content: `ASSISTANT TURN: ${summary}`,
    tags: ['assistant-response', 'claude-code', 'turn'],
    source: 'claude-code:stop',
  });

  process.exit(0);
}

main().catch((err) => {
  if (process.env.CELIUMS_DEBUG) process.stderr.write(`[stop] ${err.message}\n`);
  process.exit(0);
});
