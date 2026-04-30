// Entry point — registers commands and the status bar item, then wires
// the host to the appropriate MCP backend on activation if credentials
// are already present.

import * as vscode from 'vscode';
import { CeliumsClient } from './client';
import { detectHost, hostLabel, hasNativeMcpApi } from './host';
import { registerMcp, unregisterCursorMcp } from './mcp';

const SECRET_KEY = 'celiums.apiKey';
const CFG_URL = 'celiums.serverUrl';
const CFG_USER = 'celiums.userId';
const CFG_AUTOREG = 'celiums.autoRegisterMcp';

let statusItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'celiums.status';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('celiums.connect',       () => cmdConnect(context)),
    vscode.commands.registerCommand('celiums.disconnect',    () => cmdDisconnect(context)),
    vscode.commands.registerCommand('celiums.status',        () => cmdStatus(context)),
    vscode.commands.registerCommand('celiums.recall',        () => cmdRecall(context)),
    vscode.commands.registerCommand('celiums.remember',      () => cmdRemember(context)),
    vscode.commands.registerCommand('celiums.openDashboard', () => cmdOpenDashboard()),
  );

  // If we already have credentials, refresh the status indicator and
  // (re-)register the MCP server with the host. This is idempotent —
  // VSCode's lm provider replaces previous registrations with the
  // same id; the file-based path overwrites the same JSON entry.
  await refreshStatus(context);
  if (await hasCreds(context)) {
    const cfg = vscode.workspace.getConfiguration();
    if (cfg.get<boolean>(CFG_AUTOREG, true)) {
      await tryRegisterMcp(context, /*silent=*/true);
    }
  }
}

export function deactivate() {
  statusItem?.hide();
}

// ────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────

async function cmdConnect(ctx: vscode.ExtensionContext) {
  const host = detectHost();
  const cfg = vscode.workspace.getConfiguration();

  const url = await vscode.window.showInputBox({
    title: 'Celiums Memory — server URL',
    prompt: 'Base URL of your Celiums Memory server',
    placeHolder: 'https://memory.example.com',
    value: cfg.get<string>(CFG_URL, ''),
    ignoreFocusOut: true,
    validateInput: (v) => /^https?:\/\/.+/.test(v.trim()) ? null : 'Must start with http:// or https://',
  });
  if (!url) return;

  const apiKey = await vscode.window.showInputBox({
    title: 'Celiums Memory — API key',
    prompt: 'Find this on your dashboard\'s Settings page (or /root/.celiums/api-key on the droplet).',
    placeHolder: 'cmk_…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => /^cmk_[A-Za-z0-9_-]+$/.test(v.trim()) ? null : 'Expected a key starting with cmk_',
  });
  if (!apiKey) return;

  const userId = cfg.get<string>(CFG_USER, 'default') || 'default';

  // Probe before persisting so we surface auth issues immediately.
  const client = new CeliumsClient(url.trim(), apiKey.trim(), userId);
  const probe = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Celiums: testing connection…' },
    async () => {
      const health = await client.ping();
      if (!health.ok) return { ok: false, where: 'health', detail: health.detail };
      const auth = await client.authProbe();
      if (!auth.ok) return { ok: false, where: 'auth', detail: auth.detail };
      return { ok: true };
    },
  );

  if (!probe.ok) {
    const msg = probe.where === 'health'
      ? `Couldn't reach ${url}: ${probe.detail}`
      : `API key rejected (${probe.detail || 'unauthorized'}).`;
    vscode.window.showErrorMessage(`Celiums: ${msg}`);
    return;
  }

  await cfg.update(CFG_URL, url.trim(), vscode.ConfigurationTarget.Global);
  await ctx.secrets.store(SECRET_KEY, apiKey.trim());

  if (cfg.get<boolean>(CFG_AUTOREG, true)) {
    await tryRegisterMcp(ctx, /*silent=*/false);
  }

  vscode.window.showInformationMessage(`Celiums: connected to ${url} (${hostLabel(host)}).`);
  await refreshStatus(ctx);
}

async function cmdDisconnect(ctx: vscode.ExtensionContext) {
  const host = detectHost();
  await ctx.secrets.delete(SECRET_KEY);
  await vscode.workspace.getConfiguration().update(CFG_URL, '', vscode.ConfigurationTarget.Global);

  if (host === 'cursor') {
    const removed = await unregisterCursorMcp();
    if (removed) vscode.window.showInformationMessage('Celiums: removed entry from ~/.cursor/mcp.json');
  }

  await refreshStatus(ctx);
  vscode.window.showInformationMessage('Celiums: disconnected.');
}

async function cmdStatus(ctx: vscode.ExtensionContext) {
  const host = detectHost();
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);

  const lines: string[] = [
    `Host        : ${hostLabel(host)}`,
    `Server URL  : ${url || '(not set)'}`,
    `API key     : ${apiKey ? '✓ stored' : '✗ missing'}`,
    `Native MCP  : ${hasNativeMcpApi() ? 'yes' : 'no'}`,
  ];

  vscode.window.showInformationMessage(lines.join('  ·  '), 'Connect', 'Open Dashboard').then((pick) => {
    if (pick === 'Connect') vscode.commands.executeCommand('celiums.connect');
    if (pick === 'Open Dashboard') vscode.commands.executeCommand('celiums.openDashboard');
  });
}

async function cmdRecall(ctx: vscode.ExtensionContext) {
  const client = await getClient(ctx);
  if (!client) return;

  const query = await vscode.window.showInputBox({
    title: 'Celiums: recall',
    prompt: 'What do you want to remember?',
    placeHolder: 'e.g. the auth refactor we did last week',
    ignoreFocusOut: true,
  });
  if (!query) return;

  try {
    const hits = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Celiums: searching "${query}"…` },
      () => client.recall(query, 10),
    );

    if (hits.length === 0) {
      vscode.window.showInformationMessage('Celiums: no matching memories.');
      return;
    }

    const items = hits.map((h) => ({
      label: truncate(h.content, 80),
      description: h.score != null ? `score ${h.score.toFixed(2)}` : '',
      detail: h.createdAt ? new Date(h.createdAt).toLocaleString() : '',
      memory: h,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: `Celiums — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;

    const doc = await vscode.workspace.openTextDocument({ content: picked.memory.content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Celiums recall failed: ${(e as Error).message}`);
  }
}

async function cmdRemember(ctx: vscode.ExtensionContext) {
  const client = await getClient(ctx);
  if (!client) return;

  const editor = vscode.window.activeTextEditor;
  const selected = editor?.document.getText(editor.selection).trim();

  const content = await vscode.window.showInputBox({
    title: 'Celiums: remember',
    prompt: 'What should I save?',
    placeHolder: selected ? '(press Enter to save the current selection)' : 'Type the memory…',
    value: selected || '',
    ignoreFocusOut: true,
  });
  if (!content?.trim()) return;

  try {
    const saved = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Celiums: saving memory…' },
      () => client.remember(content.trim(), { source: 'vscode-extension', host: detectHost() }),
    );
    vscode.window.showInformationMessage(`Celiums: saved ✓ ${saved.id ? `(${saved.id.slice(0, 8)}…)` : ''}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Celiums remember failed: ${(e as Error).message}`);
  }
}

function cmdOpenDashboard() {
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  if (!url) {
    vscode.window.showWarningMessage('Celiums: no server URL configured. Run "Celiums: Connect" first.');
    return;
  }
  vscode.env.openExternal(vscode.Uri.parse(url));
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

async function tryRegisterMcp(ctx: vscode.ExtensionContext, silent: boolean) {
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);
  if (!url || !apiKey) return;

  try {
    const result = await registerMcp(detectHost(), { url, apiKey });
    if (!silent) {
      if (result.method === 'manual') {
        vscode.window.showWarningMessage(
          `Celiums: ${hostLabel(detectHost())} doesn't expose an MCP API. ` +
          `Configure manually with URL ${url}/mcp and your API key.`,
        );
      } else {
        vscode.window.showInformationMessage(
          `Celiums: MCP registered (${result.method}) — ${result.detail}`,
        );
      }
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Celiums: MCP registration failed — ${(e as Error).message}`);
  }
}

async function refreshStatus(ctx: vscode.ExtensionContext) {
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);
  if (url && apiKey) {
    statusItem.text = '$(database) Celiums';
    statusItem.tooltip = `Connected to ${url}`;
    statusItem.backgroundColor = undefined;
  } else {
    statusItem.text = '$(circle-slash) Celiums';
    statusItem.tooltip = 'Not connected — click to set up';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusItem.show();
}

async function hasCreds(ctx: vscode.ExtensionContext): Promise<boolean> {
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);
  return Boolean(url && apiKey);
}

async function getClient(ctx: vscode.ExtensionContext): Promise<CeliumsClient | null> {
  const cfg = vscode.workspace.getConfiguration();
  const url = cfg.get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);
  if (!url || !apiKey) {
    const pick = await vscode.window.showWarningMessage(
      'Celiums: not connected. Set up now?',
      'Connect',
    );
    if (pick === 'Connect') vscode.commands.executeCommand('celiums.connect');
    return null;
  }
  const userId = cfg.get<string>(CFG_USER, 'default') || 'default';
  return new CeliumsClient(url, apiKey, userId);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
