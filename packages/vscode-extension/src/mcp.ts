// MCP server registration.
//
// Two backends:
//   - Native: vscode.lm.registerMcpServerDefinitionProvider (VSCode
//     1.97+, Antigravity, future Cursor). The host editor handles
//     lifecycle, transport, auth headers, and tool surfacing.
//   - File-based: write ~/.cursor/mcp.json. Cursor watches this file
//     and (re)connects on change. We merge into existing entries to
//     avoid clobbering other servers.

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

export async function registerMcp(host: Host, reg: McpRegistration): Promise<{
  method: 'native' | 'file' | 'manual';
  detail: string;
}> {
  if (host === 'cursor') {
    const path = await writeCursorMcpJson(reg);
    return { method: 'file', detail: path };
  }

  // VSCode/Antigravity/unknown: try the native API. If unavailable
  // we fall back to writing the user-level VSCode settings.json key
  // chat.mcp.servers (which works for VSCode 1.96 with the MCP
  // preview enabled).
  const lm = (vscode as unknown as {
    lm?: {
      registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
    };
  }).lm;

  if (lm?.registerMcpServerDefinitionProvider) {
    const provider = {
      onDidChangeMcpServerDefinitions: new vscode.EventEmitter<void>().event,
      provideMcpServerDefinitions: async () => [{
        label: 'Celiums Memory',
        // The shape mirrors VSCode's McpHttpServerDefinition. Older
        // hosts ignore unknown fields, newer ones honour them.
        uri: vscode.Uri.parse(`${stripSlash(reg.url)}/mcp`),
        headers: { Authorization: `Bearer ${reg.apiKey}` },
      }],
      resolveMcpServerDefinition: async (def: unknown) => def,
    };
    lm.registerMcpServerDefinitionProvider(SERVER_NAME, provider);
    return { method: 'native', detail: 'registered with editor MCP runtime' };
  }

  return { method: 'manual', detail: 'host has no MCP API; copy config from settings' };
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
    url: `${stripSlash(reg.url)}/mcp`,
    headers: { Authorization: `Bearer ${reg.apiKey}` },
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
