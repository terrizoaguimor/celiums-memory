#!/usr/bin/env node
/**
 * SessionStart hook.
 *
 * Runs when Claude Code starts a new session. Recalls relevant memories
 * from the current working directory context and injects them so Claude
 * knows what happened in prior sessions.
 *
 * Token-efficient: uses compact search (ids + summaries only).
 */

import client from '../client.mjs';
import { readStdinBounded, safeJsonParse } from '../safe-utils.mjs';

async function main() {
  // Bounded read + prototype-pollution-safe parse
  let session = {};
  try {
    const stdin = await readStdinBounded();
    session = safeJsonParse(stdin);
  } catch {
    // Hook never blocks Claude Code on parse failures
  }

  const cwd = session.cwd || process.cwd();
  const projectName = cwd.split('/').pop() || 'project';

  // Compact search for memories relevant to this project
  const compact = await client.searchCompact({
    query: `project ${projectName} recent work decisions`,
    limit: 10,
  });

  if (!compact.memories || compact.memories.length === 0) {
    // No memories or server down — exit silently
    process.exit(0);
  }

  // Get emotional state
  const emotion = await client.emotion();

  // Build context string for Claude
  const lines = [
    `# Celiums Memory — Session Context`,
    ``,
    `**Current feeling:** ${emotion?.feeling || 'neutral'}`,
    ``,
    `**Recent relevant memories (${compact.memories.length}):**`,
    ``,
  ];

  compact.memories.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.summary} _(score: ${m.score?.toFixed(2) || '?'})_`);
  });

  lines.push('');
  lines.push('_Use `search` or `recall` MCP tools for more details. Memories persist across sessions via celiums-memory._');

  // Output as JSON so Claude Code can inject it as context
  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch((err) => {
  if (process.env.CELIUMS_DEBUG) process.stderr.write(`[session-start] ${err.message}\n`);
  process.exit(0); // Never block Claude Code
});
