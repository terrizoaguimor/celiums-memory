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

async function main() {
  let stdin = '';
  try {
    for await (const chunk of process.stdin) stdin += chunk;
  } catch {}

  let payload = {};
  try {
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {}

  const prompt = payload.prompt || payload.user_prompt || '';
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
