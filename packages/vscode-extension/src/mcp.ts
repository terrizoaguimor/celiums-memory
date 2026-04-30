// MCP server registration.
//
// We always register a stdio server that spawns `@celiums/mcp` with the
// user-supplied URL and API key. This is the universal path: VSCode,
// Antigravity, Cursor, Claude Desktop and every other MCP host
// understands stdio definitions, and `@celiums/mcp` (npm) is the
// reference shim that translates stdio MCP into the engine's
// JSON-RPC over /mcp.
//
// Why not HTTP MCP? It works in some hosts (Cursor's `url` field,
// VSCode's McpHttpServerDefinition since 1.97) but not all, and the
// shim's --url/CELIUMS_API_KEY contract guarantees the user URL is
// honored — no hardcoded api.celiums.io fallback to bite us.

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

export async function registerMcp(host: Host, reg: McpRegistration): Promise<{
  method: 'native' | 'file' | 'manual';
  detail: string;
}> {
  if (host === 'cursor') {
    const path = await writeCursorMcpJson(reg);
    return { method: 'file', detail: path };
  }

  // VSCode/Antigravity/unknown: try the native API. If unavailable
  // we fall back to a notification so the user can paste the same
  // stdio config into the host's settings UI.
  const lm = (vscode as unknown as {
    lm?: {
      registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
    };
  }).lm;

  if (lm?.registerMcpServerDefinitionProvider) {
    const stdioDef = makeStdioDef(reg);
    const provider = {
      onDidChangeMcpServerDefinitions: new vscode.EventEmitter<void>().event,
      provideMcpServerDefinitions: async () => [stdioDef],
      resolveMcpServerDefinition: async (def: unknown) => def,
    };
    lm.registerMcpServerDefinitionProvider(SERVER_NAME, provider);
    return { method: 'native', detail: 'stdio (npx @celiums/mcp) registered with editor MCP runtime' };
  }

  return { method: 'manual', detail: 'host has no MCP API; paste the stdio config into your settings' };
}

// vscode.lm's McpStdioServerDefinition shape (1.97+). Older hosts
// silently drop unknown fields, so this stays forward-compatible.
function makeStdioDef(reg: McpRegistration) {
  return {
    label: 'Celiums Memory',
    command: 'npx',
    args: ['-y', SHIM_PACKAGE, '--url', stripSlash(reg.url)],
    env: { CELIUMS_API_KEY: reg.apiKey },
  };
}

async function writeCursorMcpJson(reg: McpRegistration): Promise<string> {
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
  return file;
}

export async function unregisterCursorMcp(): Promise<boolean> {
  const file = join(homedir(), '.cursor', 'mcp.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (data.mcpServers && SERVER_NAME in data.mcpServers) {
      delete data.mcpServers[SERVER_NAME];
      await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
      return true;
    }
  } catch {
    /* nothing to remove */
  }
  return false;
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
