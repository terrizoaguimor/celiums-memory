#!/usr/bin/env node
/**
 * celiums-memory installer for Claude Code.
 *
 * Configures ~/.claude.json with:
 *  1. MCP server (celiums-memory) exposing 6 tools
 *  2. 5 hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd)
 *
 * Run: npx @celiums/memory-claude-code install
 *   or: node bin/install.js
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const MEMORY_URL = process.env.CELIUMS_MEMORY_URL || 'http://localhost:3210';
const USER_ID = process.env.CELIUMS_MEMORY_USER_ID || 'default';

const BRIDGE_PATH = path.join(PLUGIN_ROOT, 'src', 'bridge.mjs');
const HOOKS = {
  SessionStart: path.join(PLUGIN_ROOT, 'src', 'hooks', 'session-start.mjs'),
  UserPromptSubmit: path.join(PLUGIN_ROOT, 'src', 'hooks', 'user-prompt.mjs'),
  PostToolUse: path.join(PLUGIN_ROOT, 'src', 'hooks', 'post-tool-use.mjs'),
  Stop: path.join(PLUGIN_ROOT, 'src', 'hooks', 'stop.mjs'),
  SessionEnd: path.join(PLUGIN_ROOT, 'src', 'hooks', 'session-end.mjs'),
};

const COGNITIVE_REFLEXES = [
  'pre-response-recall',
  'decision-encoding',
  'emotional-calibration',
  'salience-filtering',
  'session-consolidation',
  'context-recovery',
  'habituation-check',
  'surface-learnings',
  'reflex-create',
];

function log(msg) {
  process.stdout.write(`[celiums-memory] ${msg}\n`);
}

function readConfig() {
  if (!fs.existsSync(CLAUDE_CONFIG)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'));
  } catch (err) {
    log(`Could not parse ${CLAUDE_CONFIG}: ${err.message}`);
    log('Create a backup and run again, or edit manually.');
    process.exit(1);
  }
}

function writeConfig(config) {
  // Backup first
  if (fs.existsSync(CLAUDE_CONFIG)) {
    const backup = `${CLAUDE_CONFIG}.backup-${Date.now()}`;
    fs.copyFileSync(CLAUDE_CONFIG, backup);
    log(`Backup saved: ${backup}`);
  }
  fs.writeFileSync(CLAUDE_CONFIG, JSON.stringify(config, null, 2));
  log(`Updated: ${CLAUDE_CONFIG}`);
}

function installMcp(config) {
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['celiums-memory'] = {
    command: 'node',
    args: [BRIDGE_PATH],
    env: {
      CELIUMS_MEMORY_URL: MEMORY_URL,
      CELIUMS_MEMORY_USER_ID: USER_ID,
    },
  };

  log('MCP server configured: celiums-memory (6 tools)');
}

function installReflexes() {
  const srcDir = path.join(PLUGIN_ROOT, 'skills');
  if (!fs.existsSync(srcDir)) {
    log('WARNING: skills directory not found — skipping cognitive reflexes');
    return;
  }

  fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });

  let installed = 0;
  for (const reflex of COGNITIVE_REFLEXES) {
    const srcPath = path.join(srcDir, reflex, 'SKILL.md');
    const dstDir = path.join(CLAUDE_SKILLS_DIR, reflex);
    const dstPath = path.join(dstDir, 'SKILL.md');

    if (!fs.existsSync(srcPath)) {
      log(`  Missing reflex source: ${reflex}`);
      continue;
    }

    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
    installed++;
  }

  log(`Cognitive reflexes installed: ${installed}/${COGNITIVE_REFLEXES.length} to ${CLAUDE_SKILLS_DIR}`);
}

function installHooks(config) {
  if (!config.hooks) config.hooks = {};

  for (const [eventName, hookPath] of Object.entries(HOOKS)) {
    if (!config.hooks[eventName]) config.hooks[eventName] = [];

    // Check if already installed
    const existing = config.hooks[eventName].find((h) =>
      h.hooks?.some((hk) => hk.command?.includes('celiums-memory')),
    );

    if (existing) {
      log(`Hook already installed: ${eventName}`);
      continue;
    }

    config.hooks[eventName].push({
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `node ${hookPath}`,
          timeout: 10,
        },
      ],
    });

    log(`Hook installed: ${eventName}`);
  }
}

function uninstall() {
  const config = readConfig();

  if (config.mcpServers?.['celiums-memory']) {
    delete config.mcpServers['celiums-memory'];
    log('MCP server removed.');
  }

  if (config.hooks) {
    for (const eventName of Object.keys(HOOKS)) {
      if (!config.hooks[eventName]) continue;
      config.hooks[eventName] = config.hooks[eventName].filter(
        (h) => !h.hooks?.some((hk) => hk.command?.includes('celiums-memory')),
      );
      if (config.hooks[eventName].length === 0) delete config.hooks[eventName];
    }
    log('Hooks removed.');
  }

  writeConfig(config);

  // Remove cognitive reflexes
  let removed = 0;
  for (const reflex of COGNITIVE_REFLEXES) {
    const dir = path.join(CLAUDE_SKILLS_DIR, reflex);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  if (removed > 0) log(`Cognitive reflexes removed: ${removed}`);

  log('Uninstall complete. Restart Claude Code.');
}

function install() {
  log('Installing celiums-memory plugin for Claude Code...');

  // Verify bridge and hooks exist
  if (!fs.existsSync(BRIDGE_PATH)) {
    log(`ERROR: Bridge script not found at ${BRIDGE_PATH}`);
    process.exit(1);
  }

  for (const [name, hookPath] of Object.entries(HOOKS)) {
    if (!fs.existsSync(hookPath)) {
      log(`ERROR: Hook script not found: ${name} (${hookPath})`);
      process.exit(1);
    }
  }

  const config = readConfig();
  installMcp(config);
  installHooks(config);
  writeConfig(config);
  installReflexes();

  log('');
  log('  Installation complete.');
  log('');
  log(`  Memory URL:  ${MEMORY_URL}`);
  log(`  User ID:     ${USER_ID}`);
  log('');
  log('  Next steps:');
  log('    1. Start the celiums-memory server (if using local):');
  log('         npx @celiums/memory  (or: cd celiums-memory && npm start)');
  log('    2. Restart Claude Code');
  log('    3. Claude will now have automatic persistent memory + emotions');
  log('');
  log('  To uninstall: node bin/install.js --uninstall');
}

// ─── Entry ─────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--uninstall') || args.includes('-u')) {
  uninstall();
} else {
  install();
}
