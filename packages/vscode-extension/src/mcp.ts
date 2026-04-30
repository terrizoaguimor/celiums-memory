// MCP server registration.
//
// Three behaviors composed into one provider, so the same extension
// works on every MCP host without per-editor branching at the call
// site:
//
//   1. Native API (VSCode 1.97+, Antigravity, future Cursor):
//      registerMcpServerDefinitionProvider with an emitter so we can
//      fire change events when the user (re)connects or disconnects.
//      Definitions are real `vscode.McpStdioServerDefinition` class
//      instances — VSCode silently ignores plain objects with the
//      same shape, which is the bug that bit us in 1.2.10/1.2.11.
//
//   2. File-based (Cursor today):
//      merge into ~/.cursor/mcp.json. Cursor watches the file and
//      reconnects on change.
//
// The wire payload is identical in both cases:
//   command = npx
//   args    = ['-y', '@celiums/mcp@latest', '--url', <user URL>]
//   env     = { CELIUMS_API_KEY: <user key> }
//
// Passing --url explicitly bypasses the shim's hardcoded default
// (api.celiums.io) so the user's actual server is the one being hit,
// every time.

import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Host } from './host';

export interface McpRegistration {
  url: string;
  apiKey: string;
}

const SERVER_NAME = 'celiums-memory';
const SHIM_PACKAGE = '@celiums/mcp@latest';

let providerRegistered = false;
let definitionsEmitter: vscode.EventEmitter<void> | undefined;
let currentReg: McpRegistration | undefined;

// Idempotent — call this once on activation. Subsequent calls are
// no-ops. Returns true if the native provider was wired up; false
// if the host doesn't expose the MCP API at all.
export function ensureProviderRegistered(
  ctx: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): boolean {
  if (providerRegistered) return true;

  const lm = (vscode as unknown as {
    lm?: {
      registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
    };
  }).lm;
  if (!lm?.registerMcpServerDefinitionProvider) {
    log.appendLine('[mcp] host has no vscode.lm.registerMcpServerDefinitionProvider — falling back to file-based or manual');
    return false;
  }

  const McpStdioServerDefinition = (vscode as unknown as {
    McpStdioServerDefinition?: new (
      label: string,
      command: string,
      args?: string[],
      env?: Record<string, string | number | null>,
      version?: string,
      cwd?: vscode.Uri,
    ) => unknown;
  }).McpStdioServerDefinition;
  if (!McpStdioServerDefinition) {
    log.appendLine('[mcp] vscode.lm exists but vscode.McpStdioServerDefinition is missing — host predates the stable MCP API');
    return false;
  }

  definitionsEmitter = new vscode.EventEmitter<void>();

  const provider = {
    onDidChangeMcpServerDefinitions: definitionsEmitter.event,
    provideMcpServerDefinitions: () => {
      if (!currentReg) {
        log.appendLine('[mcp] provideMcpServerDefinitions called — no credentials yet, returning []');
        return [];
      }
      const def = new McpStdioServerDefinition(
        'Celiums Memory',
        'npx',
        ['-y', SHIM_PACKAGE, '--url', stripSlash(currentReg.url)],
        { CELIUMS_API_KEY: currentReg.apiKey },
      );
      log.appendLine(`[mcp] provideMcpServerDefinitions → 1 stdio server (--url ${currentReg.url})`);
      return [def];
    },
    resolveMcpServerDefinition: (def: unknown) => def,
  };

  const disp = lm.registerMcpServerDefinitionProvider(SERVER_NAME, provider);
  ctx.subscriptions.push(disp);
  providerRegistered = true;
  log.appendLine(`[mcp] provider "${SERVER_NAME}" registered with the editor`);
  return true;
}

// Pushes new credentials into the provider and fires the change
// event so the host re-queries provideMcpServerDefinitions.
export function setRegistration(
  reg: McpRegistration | undefined,
  log: vscode.OutputChannel,
): void {
  currentReg = reg;
  if (reg) {
    log.appendLine(`[mcp] credentials set: url=${reg.url} (key length ${reg.apiKey.length})`);
  } else {
    log.appendLine('[mcp] credentials cleared');
  }
  if (definitionsEmitter) {
    definitionsEmitter.fire();
    log.appendLine('[mcp] fired onDidChangeMcpServerDefinitions');
  }
}

// File-based fallback for Cursor. Returns the path it touched, or
// null if it did nothing.
export async function writeCursorMcpJson(
  reg: McpRegistration,
  log: vscode.OutputChannel,
): Promise<string> {
  const dir = join(homedir(), '.cursor');
  const file = join(dir, 'mcp.json');
  await fs.mkdir(dir, { recursive: true });

  let existing: { mcpServers?: Record<string, unknown> } = {};
  try {
    const raw = await fs.readFile(file, 'utf8');
    existing = JSON.parse(raw);
  } catch {
    /* fresh file */
  }

  existing.mcpServers ??= {};
  existing.mcpServers[SERVER_NAME] = {
    command: 'npx',
    args: ['-y', SHIM_PACKAGE, '--url', stripSlash(reg.url)],
    env: { CELIUMS_API_KEY: reg.apiKey },
  };

  await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  log.appendLine(`[mcp] wrote stdio entry to ${file}`);
  return file;
}

export async function unregisterCursorMcp(log: vscode.OutputChannel): Promise<boolean> {
  const file = join(homedir(), '.cursor', 'mcp.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (data.mcpServers && SERVER_NAME in data.mcpServers) {
      delete data.mcpServers[SERVER_NAME];
      await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
      log.appendLine(`[mcp] removed stdio entry from ${file}`);
      return true;
    }
  } catch {
    /* nothing to remove */
  }
  return false;
}

// High-level: figure out what backend the host supports and apply
// the registration accordingly. Called from connect/disconnect.
export async function applyRegistration(
  host: Host,
  reg: McpRegistration | undefined,
  ctx: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<{ method: 'native' | 'file' | 'manual'; detail: string }> {
  const native = ensureProviderRegistered(ctx, log);
  if (native) {
    setRegistration(reg, log);
    return { method: 'native', detail: 'registered with the editor MCP runtime (stdio shim)' };
  }

  // File-based for Cursor specifically.
  if (host === 'cursor') {
    if (reg) {
      const path = await writeCursorMcpJson(reg, log);
      return { method: 'file', detail: path };
    }
    await unregisterCursorMcp(log);
    return { method: 'file', detail: 'cleared ~/.cursor/mcp.json' };
  }

  // Truly unknown host: tell the user to paste the config manually.
  log.appendLine('[mcp] host has neither lm API nor file-based config — manual setup required');
  return { method: 'manual', detail: 'host has no MCP API; paste the stdio config into your settings' };
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
