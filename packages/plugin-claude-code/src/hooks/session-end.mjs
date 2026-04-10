#!/usr/bin/env node
/**
 * SessionEnd hook.
 *
 * Runs when Claude Code closes. Triggers consolidation — the limbic
 * engine will dedupe similar memories and migrate them between tiers
 * (hot → warm → cold → archive) based on importance and decay.
 */

import client from '../client.mjs';
import { readStdinBounded, safeJsonParse, redactSecrets } from '../safe-utils.mjs';

async function main() {
  let payload = {};
  try {
    const stdin = await readStdinBounded();
    payload = safeJsonParse(stdin);
  } catch {}

  const transcript = payload.transcript || payload.session_summary || '';

  // Only consolidate if we have a meaningful conversation
  if (!transcript || transcript.length < 100) {
    process.exit(0);
  }

  const conversation = redactSecrets(
    typeof transcript === 'string' ? transcript : JSON.stringify(transcript),
  );
  await client.consolidate({ conversation });

  process.exit(0);
}

main().catch((err) => {
  if (process.env.CELIUMS_DEBUG) process.stderr.write(`[session-end] ${err.message}\n`);
  process.exit(0);
});
