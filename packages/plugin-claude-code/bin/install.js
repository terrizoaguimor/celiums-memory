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
import { atomicWriteJsonSafe, assertPathContains, safeJsonParse } from '../src/safe-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json');
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const REMOTE_URL = process.env.CELIUMS_MEMORY_URL || 'http://127.0.0.1:3210';
const API_KEY = process.env.CELIUMS_API_KEY || '';
const TENANT_ID = process.env.CELIUMS_TENANT_ID || 'default';
const USER_ID = process.env.CELIUMS_MEMORY_USER_ID || os.userInfo().username || 'default';

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
  // Refuse to read through a symlink — defeats the symlink-swap race
  const stat = fs.lstatSync(CLAUDE_CONFIG);
  if (stat.isSymbolicLink()) {
    log(`ERROR: ${CLAUDE_CONFIG} is a symlink. Refusing to read for safety.`);
    process.exit(1);
  }
  try {
    // safeJsonParse rejects __proto__/constructor/prototype keys
    return safeJsonParse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'));
  } catch (err) {
    log(`Could not parse ${CLAUDE_CONFIG}: ${err.message}`);
    log('Create a backup and run again, or edit manually.');
    process.exit(1);
  }
}

function writeConfig(config) {
  // Backup first (only if real file, not symlink)
  if (fs.existsSync(CLAUDE_CONFIG)) {
    const stat = fs.lstatSync(CLAUDE_CONFIG);
    if (stat.isSymbolicLink()) {
      log(`ERROR: ${CLAUDE_CONFIG} became a symlink. Refusing to write.`);
      process.exit(1);
    }
    const backup = `${CLAUDE_CONFIG}.backup-${Date.now()}`;
    fs.copyFileSync(CLAUDE_CONFIG, backup);
    log(`Backup saved: ${backup}`);
  }
  // Atomic write via temp file + rename, with mode 0600
  atomicWriteJsonSafe(CLAUDE_CONFIG, config);
  log(`Updated: ${CLAUDE_CONFIG}`);
}

function installMcp(config) {
  if (!config.mcpServers) config.mcpServers = {};

  const env = {
    CELIUMS_MEMORY_URL: REMOTE_URL,
    CELIUMS_TENANT_ID: TENANT_ID,
    CELIUMS_MEMORY_USER_ID: USER_ID,
  };
  if (API_KEY) env.CELIUMS_API_KEY = API_KEY;

  config.mcpServers['celiums-memory'] = {
    command: 'node',
    args: [BRIDGE_PATH],
    env,
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

  // Keep hook credentials aligned with the MCP bridge.
  const apiKeyExport = API_KEY ? `CELIUMS_API_KEY=${shellEscape(API_KEY)} ` : '';
  const envPrefix = `CELIUMS_MEMORY_URL=${shellEscape(REMOTE_URL)} CELIUMS_TENANT_ID=${shellEscape(TENANT_ID)} ${apiKeyExport}CELIUMS_MEMORY_USER_ID=${shellEscape(USER_ID)} `;

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
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: `${envPrefix}node ${hookPath}`,
          timeout: 10,
        },
      ],
    });

    log(`Hook installed: ${eventName}`);
  }
}

function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
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

function checkClaudeCodeInstalled() {
  return fs.existsSync(CLAUDE_CONFIG) || fs.existsSync(path.join(os.homedir(), '.claude'));
}

async function install() {
  process.stdout.write(`
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   🧠  celiums-memory plugin for Claude Code           ║
  ║       Local-first persistent memory                   ║
  ║                                                       ║
  ╚═══════════════════════════════════════════════════════╝

`);

  // Pre-flight: Claude Code installed?
  if (!checkClaudeCodeInstalled()) {
    log('⚠  Claude Code does not appear to be installed.');
    log('   Install it first: https://claude.com/claude-code');
    log('   Then run this installer again.');
    log('');
    log('   Continuing anyway in case you have a custom setup...');
    log('');
  }

  log(`Server: ${REMOTE_URL}`);
  log(`Tenant: ${TENANT_ID}`);
  log('The plugin uses the native Rust memory server over HTTP/MCP.');
  log('');

  // Path containment — every hook and bridge MUST live inside PLUGIN_ROOT.
  // Defeats path-traversal via malicious package layouts or symlinks.
  try {
    assertPathContains(PLUGIN_ROOT, BRIDGE_PATH);
    for (const [, hookPath] of Object.entries(HOOKS)) {
      assertPathContains(PLUGIN_ROOT, hookPath);
    }
  } catch (err) {
    log(`SECURITY: ${err.message}`);
    log('Refusing to install. Reinstall the package from npm.');
    process.exit(1);
  }

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

  process.stdout.write(`
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   ✓  Installation complete                            ║
  ║                                                       ║
  ╚═══════════════════════════════════════════════════════╝

   Server    : ${REMOTE_URL}
   Tenant    : ${TENANT_ID}
  User ID   : ${USER_ID}
  Config    : ~/.claude.json
  Reflexes  : ~/.claude/skills/ (9 cognitive reflexes)

  WHAT JUST HAPPENED:
    • 6 new MCP tools in Claude Code
        remember, recall, search, timeline, emotion, forget
    • 5 lifecycle hooks capture context automatically
    • 9 cognitive reflexes teach Claude when to use memory
     • Memories are stored by the authenticated Rust server

  NEXT:
    1. Restart Claude Code (quit + reopen)
    2. Ask Claude in a new session:
         "remember that I prefer concise answers"
       Then in ANOTHER new session:
         "what do you remember about how I like answers?"
       Watch it actually remember.

   CONFIGURATION:
     CELIUMS_MEMORY_URL=${REMOTE_URL}
     CELIUMS_TENANT_ID=${TENANT_ID}
     CELIUMS_API_KEY=<native Rust server key>

  To uninstall:
       npx @celiums/memory-claude-code --uninstall

  Docs: https://github.com/terrizoaguimor/celiums-memory

`);
}

// ─── Entry ─────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--uninstall') || args.includes('-u')) {
  uninstall();
} else {
  install().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
