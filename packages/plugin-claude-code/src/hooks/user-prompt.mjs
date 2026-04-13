#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 *
 * 1. Fetches circadian state and outputs it so Claude adapts tone/energy
 * 2. Stores the prompt as a memory for PAD emotion extraction
 *
 * Non-blocking — if memory is down, the prompt still reaches Claude normally.
 */

import client from '../client.mjs';
import { readStdinBounded, safeJsonParse, redactSecrets } from '../safe-utils.mjs';

function greetingForHour(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function phaseDescription(phase) {
  const map = {
    'deep-night': 'deep night — rest mode',
    'pre-dawn': 'pre-dawn — body waking up',
    'morning-rise': 'morning — energy rising',
    'morning-peak': 'morning peak — highest focus',
    'midday': 'midday — sustained energy',
    'afternoon-dip': 'afternoon — natural energy dip',
    'evening-wind-down': 'evening — winding down',
    'night-onset': 'night — transitioning to rest',
  };
  return map[phase] || phase || 'unknown';
}

async function main() {
  let payload = {};
  try {
    const stdin = await readStdinBounded();
    payload = safeJsonParse(stdin);
  } catch {
    process.exit(0);
  }

  // 1. Circadian context injection
  try {
    const c = await client.circadian();
    if (c && c.localHour != null) {
      const h = Math.floor(c.localHour);
      const m = String(Math.floor((c.localHour % 1) * 60)).padStart(2, '0');
      const greeting = greetingForHour(c.localHour);
      const phase = phaseDescription(c.timeOfDay);
      const rhythm = c.rhythmComponent?.toFixed(2) || '?';
      process.stdout.write(
        `[Circadian] ${greeting}. Local time: ${h}:${m}. ` +
        `Phase: ${phase}. Rhythm: ${rhythm}. ` +
        `Adapt your tone and energy to this time of day.\n`
      );
    }
  } catch { /* silent */ }

  // 2. Store prompt for emotion extraction
  const rawPrompt = payload.prompt || payload.user_prompt || '';
  const prompt = redactSecrets(rawPrompt);
  if (!prompt || prompt.length < 3) {
    process.exit(0);
  }

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
