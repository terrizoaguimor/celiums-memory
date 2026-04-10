#!/usr/bin/env node
/**
 * PostToolUse hook.
 *
 * Runs after Claude uses a tool. Captures significant observations
 * (file edits, command outputs, search results) as memories.
 *
 * Filters out noise: reads under 500 chars, trivial operations, etc.
 */

import client from '../client.mjs';

const IGNORE_TOOLS = new Set(['TodoWrite', 'Glob']);
const SIGNIFICANT_TOOLS = new Set(['Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Grep', 'Read']);
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 2000;

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

  const toolName = payload.tool_name || payload.toolName || '';
  const toolInput = payload.tool_input || payload.toolInput || {};
  const toolResult = payload.tool_result || payload.toolResult || '';

  if (IGNORE_TOOLS.has(toolName)) process.exit(0);

  // Build a concise observation summary
  let observation = '';

  if (toolName === 'Edit' || toolName === 'Write') {
    observation = `${toolName} on ${toolInput.file_path || '?'}`;
  } else if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').substring(0, 200);
    observation = `BASH: ${cmd}`;
  } else if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    observation = `${toolName}: ${toolInput.url || toolInput.query || '?'}`;
  } else if (toolName === 'Grep') {
    observation = `GREP: "${toolInput.pattern || '?'}" in ${toolInput.path || '.'}`;
  } else if (toolName === 'Read') {
    observation = `READ ${toolInput.file_path || '?'}`;
  } else if (SIGNIFICANT_TOOLS.has(toolName)) {
    observation = `${toolName}: ${JSON.stringify(toolInput).substring(0, 200)}`;
  } else {
    // Unknown tool — skip
    process.exit(0);
  }

  // Only store if observation is meaningful
  if (observation.length < MIN_CONTENT_LENGTH) process.exit(0);

  // Truncate to a reasonable size
  const content = observation.substring(0, MAX_CONTENT_LENGTH);

  await client.store({
    content,
    tags: ['tool-observation', toolName.toLowerCase(), 'claude-code'],
    source: `claude-code:${toolName}`,
  });

  process.exit(0);
}

main().catch((err) => {
  if (process.env.CELIUMS_DEBUG) process.stderr.write(`[post-tool-use] ${err.message}\n`);
  process.exit(0);
});
