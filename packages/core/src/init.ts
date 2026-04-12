#!/usr/bin/env node
/**
 * celiums init — First-run onboarding for the super software.
 *
 * Detects OS locale + timezone, asks the user a few questions,
 * creates their profile (per-user circadian), hydrates the 5,100
 * starter modules, and prints connection instructions.
 *
 * Usage:
 *   npx celiums init              (interactive)
 *   npx celiums init --defaults   (non-interactive, use OS defaults)
 *   CELIUMS_USER_NAME=Alice ... celiums init  (env-var driven, Docker)
 *
 * @package @celiums/memory
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectLocale, detectTimezone, chronotypeToPeakHour,
  t, SUPPORTED_LOCALES, type SupportedLocale,
} from './locales/index.js';

// ── Interactive prompt helper ────────────────────────────

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function choose(rl: readline.Interface, question: string, options: string[], defaultIdx = 0): Promise<number> {
  return new Promise((resolve) => {
    console.log(`  ${question}`);
    options.forEach((o, i) => console.log(`    ${i === defaultIdx ? '▸' : ' '} ${i + 1}. ${o}`));
    rl.question(`  Choice [${defaultIdx + 1}]: `, (answer) => {
      const n = parseInt(answer.trim(), 10);
      resolve((n >= 1 && n <= options.length) ? n - 1 : defaultIdx);
    });
  });
}

// ── Main init flow ───────────────────────────────────────

export interface InitResult {
  locale: SupportedLocale;
  name: string;
  timezoneIana: string;
  timezoneOffset: number;
  peakHour: number;
  chronotype: 'morning' | 'neutral' | 'night';
}

export async function runInit(options?: {
  defaults?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<InitResult> {
  const env = options?.env ?? process.env;
  const useDefaults = options?.defaults || !!env.CELIUMS_USER_NAME;

  // Auto-detect
  const detectedLocale = detectLocale();
  const detectedTz = detectTimezone();

  if (useDefaults) {
    // Non-interactive (Docker / CI)
    const locale = (env.CELIUMS_LANGUAGE as SupportedLocale) || detectedLocale;
    const name = env.CELIUMS_USER_NAME || 'developer';
    const tz = env.CELIUMS_TIMEZONE || detectedTz.iana;
    const offset = env.CELIUMS_TIMEZONE_OFFSET
      ? parseFloat(env.CELIUMS_TIMEZONE_OFFSET)
      : detectedTz.offset;
    const chrono = (env.CELIUMS_CHRONOTYPE as 'morning' | 'neutral' | 'night') || 'neutral';

    console.log('');
    console.log(t(locale, 'welcome'));
    console.log(t(locale, 'firstRunDetected'));
    console.log(t(locale, 'profileCreated', {
      name, tz, offset: offset >= 0 ? `+${offset}` : String(offset), chrono,
    }));

    return {
      locale,
      name,
      timezoneIana: tz,
      timezoneOffset: offset,
      peakHour: chronotypeToPeakHour(chrono),
      chronotype: chrono,
    };
  }

  // Interactive
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log(t(detectedLocale, 'welcome'));
    console.log(`  ${t(detectedLocale, 'setupIntro')}`);
    console.log('');

    // 1. Language
    const langIdx = await choose(
      rl,
      t(detectedLocale, 'askLanguage'),
      ['English', 'Español', 'Português (Brasil)', '中文 (简体)', '日本語'],
      SUPPORTED_LOCALES.indexOf(detectedLocale),
    );
    const locale = SUPPORTED_LOCALES[langIdx]!;

    // 2. Name
    const name = await ask(rl, t(locale, 'askName'), env.USER || 'developer');

    // 3. Timezone
    const tzDefault = `${detectedTz.iana} (UTC${detectedTz.offset >= 0 ? '+' : ''}${detectedTz.offset})`;
    const tzInput = await ask(rl, t(locale, 'askTimezone'), tzDefault);
    const timezoneIana = tzInput.includes('(') ? detectedTz.iana : (tzInput || detectedTz.iana);
    const timezoneOffset = detectedTz.offset;

    // 4. Chronotype
    const chronoIdx = await choose(rl, t(locale, 'askChronotype'), [
      t(locale, 'chronoMorning'),
      t(locale, 'chronoNeutral'),
      t(locale, 'chronoNight'),
    ], 1);
    const chronotype = (['morning', 'neutral', 'night'] as const)[chronoIdx]!;
    const peakHour = chronotypeToPeakHour(chronotype);

    console.log('');
    console.log(t(locale, 'profileCreated', {
      name,
      tz: timezoneIana,
      offset: timezoneOffset >= 0 ? `+${timezoneOffset}` : String(timezoneOffset),
      chrono: t(locale, `chrono${chronotype.charAt(0).toUpperCase() + chronotype.slice(1)}`),
    }));

    return { locale, name, timezoneIana, timezoneOffset, peakHour, chronotype };
  } finally {
    rl.close();
  }
}

/**
 * Auto-detect installed IDEs and wire MCP config.
 * Returns which IDEs were configured.
 */
export function autoWireIdes(locale: SupportedLocale): string[] {
  const home = os.homedir();
  const wired: string[] = [];

  // ── Claude Code (~/.claude.json) ──────────────────────
  const claudeJsonPath = path.join(home, '.claude.json');
  try {
    if (fs.existsSync(claudeJsonPath)) {
      const raw = fs.readFileSync(claudeJsonPath, 'utf8');
      const config = JSON.parse(raw);
      // Find or create the mcpServers section (can be top-level or nested in project)
      if (!config.mcpServers) config.mcpServers = {};
      if (!config.mcpServers.celiums) {
        config.mcpServers.celiums = {
          command: 'celiums',
          args: ['start', '--mcp'],
          env: {},
        };
        // Backup original
        fs.copyFileSync(claudeJsonPath, `${claudeJsonPath}.bak-pre-celiums-init`);
        fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
        wired.push('Claude Code');
      } else {
        wired.push('Claude Code (already configured)');
      }
    }
  } catch { /* skip if can't read/write */ }

  // ── Cursor (~/.cursor/mcp.json) ───────────────────────
  const cursorGlobal = path.join(home, '.cursor', 'mcp.json');
  try {
    const cursorDir = path.dirname(cursorGlobal);
    if (fs.existsSync(cursorDir)) {
      let config: any = {};
      if (fs.existsSync(cursorGlobal)) {
        config = JSON.parse(fs.readFileSync(cursorGlobal, 'utf8'));
      }
      if (!config.mcpServers) config.mcpServers = {};
      if (!config.mcpServers.celiums) {
        config.mcpServers.celiums = {
          command: 'celiums',
          args: ['start', '--mcp'],
        };
        fs.writeFileSync(cursorGlobal, JSON.stringify(config, null, 2));
        wired.push('Cursor');
      } else {
        wired.push('Cursor (already configured)');
      }
    }
  } catch { /* skip */ }

  // ── VS Code (global settings) ─────────────────────────
  // VS Code MCP is in user settings.json under "mcp.servers"
  const vscodePaths = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), // macOS
    path.join(home, '.config', 'Code', 'User', 'settings.json'),                         // Linux
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),              // Windows
  ];
  for (const vscPath of vscodePaths) {
    try {
      if (fs.existsSync(vscPath)) {
        const config = JSON.parse(fs.readFileSync(vscPath, 'utf8'));
        if (!config['mcp.servers']) config['mcp.servers'] = {};
        if (!config['mcp.servers'].celiums) {
          config['mcp.servers'].celiums = {
            type: 'stdio',
            command: 'celiums',
            args: ['start', '--mcp'],
          };
          fs.copyFileSync(vscPath, `${vscPath}.bak-pre-celiums-init`);
          fs.writeFileSync(vscPath, JSON.stringify(config, null, 2));
          wired.push('VS Code');
        } else {
          wired.push('VS Code (already configured)');
        }
        break; // only configure once
      }
    } catch { /* skip */ }
  }

  return wired;
}

/**
 * Print connection instructions after init is complete.
 * If IDEs were auto-wired, just shows "restart IDE".
 * If not, shows manual instructions.
 */
export function printConnectionInstructions(locale: SupportedLocale, url: string, wiredIdes?: string[]): void {
  console.log('');

  if (wiredIdes && wiredIdes.length > 0) {
    console.log('  Detected IDEs:');
    for (const ide of wiredIdes) {
      console.log(`    ✓ ${ide}`);
    }
    console.log('');
    console.log('  Restart your IDE and Celiums will be available.');
  } else {
    console.log(`  ${t(locale, 'connectClaude')}`);
    console.log(`    claude mcp add celiums -- celiums start --mcp`);
    console.log('');
    console.log(`  ${t(locale, 'connectCursor')}`);
    console.log('    Add to ~/.cursor/mcp.json:');
    console.log(`    {"mcpServers":{"celiums":{"command":"celiums","args":["start","--mcp"]}}}`);
    console.log('');
    console.log(`  ${t(locale, 'connectVscode')}`);
    console.log('    Add to VS Code settings.json:');
    console.log(`    {"mcp.servers":{"celiums":{"type":"stdio","command":"celiums","args":["start","--mcp"]}}}`);
  }
  console.log('');
}

// ── Standalone execution ─────────────────────────────────

if (process.argv[1]?.endsWith('init.ts') || process.argv[1]?.endsWith('init.js')) {
  const defaults = process.argv.includes('--defaults');
  runInit({ defaults }).then((result) => {
    console.log('\nInit result:', JSON.stringify(result, null, 2));
  }).catch((err) => {
    console.error('Init failed:', err.message);
    process.exit(1);
  });
}
