#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 *
 * Runs when the user submits a prompt to Claude. Stores the prompt as a
 * memory so celiums-memory can extract PAD emotions and track patterns.
 *
 * Non-blocking — if memory is down, the prompt still reaches Claude normally.
 */

import client from '../client.mjs';
import { readStdinBounded, safeJsonParse, redactSecrets } from '../safe-utils.mjs';

async function main() {
  let payload = {};
  try {
    const stdin = await readStdinBounded();
    payload = safeJsonParse(stdin);
  } catch {
    process.exit(0);
  }

  const rawPrompt = payload.prompt || payload.user_prompt || '';
  // Redact common secret patterns before any storage
  const prompt = redactSecrets(rawPrompt);
  if (!prompt || prompt.length < 3) {
    process.exit(0);
  }

  // Store the prompt so the limbic engine can extract emotion + intent
  await client.store({
    content: `USER PROMPT: ${prompt}`,
    tags: ['user-prompt', 'claude-code'],
    source: 'claude-code:user-prompt',
  });

  process.exit(0);
}

main().catch((err) => {
  if (process.env.CELIUMS_DEBUG) process.stderr.write(`[user-prompt] ${err.message}\n`);
  process.exit(0);
});
