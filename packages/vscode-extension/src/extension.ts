// Entry point — registers commands, status bar, MCP provider and the
// output channel on activation. The MCP provider is wired up
// unconditionally so the editor knows about it before the user even
// opens the connect wizard; credentials get pushed into it later.

import * as vscode from 'vscode';
import { CeliumsClient } from './client';
import { detectHost, hostLabel, hasNativeMcpApi } from './host';
import { applyRegistration, ensureProviderRegistered, setRegistration } from './mcp';

const SECRET_KEY = 'celiums.apiKey';
const CFG_URL = 'celiums.serverUrl';
const CFG_USER = 'celiums.userId';

let statusItem: vscode.StatusBarItem;
let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Celiums Memory');
  context.subscriptions.push(log);
  log.appendLine(`[boot] activating in ${hostLabel(detectHost())} (${vscode.env.appName} ${vscode.version})`);
  log.appendLine(`[boot] native MCP API present: ${hasNativeMcpApi()}`);

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
    vscode.commands.registerCommand('celiums.showLogs',      () => log.show(true)),
  );

  // Register the MCP provider eagerly so the editor enumerates it
  // even before the user has connected. provideMcpServerDefinitions
  // returns [] until credentials show up, then the change emitter
  // tells the host to re-query.
  ensureProviderRegistered(context, log);

  // If we already have credentials from a previous session, push
  // them into the provider now so tools come online without the
  // user having to re-run Connect.
  const existing = await loadCreds(context);
  if (existing) {
    setRegistration(existing, log);
  }

  await refreshStatus(context);
}

export function deactivate() {
  statusItem?.hide();
}

// ────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────

async function cmdConnect(ctx: vscode.ExtensionContext) {
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
    prompt: "Find this on your dashboard's Settings page (or /root/.celiums/api-key on the droplet).",
    placeHolder: 'cmk_…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => /^cmk_[A-Za-z0-9_-]+$/.test(v.trim()) ? null : 'Expected a key starting with cmk_',
  });
  if (!apiKey) return;

  const userId = cfg.get<string>(CFG_USER, 'default') || 'default';
  log.appendLine(`[connect] probing ${url} as user "${userId}"`);

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
    log.appendLine(`[connect] FAILED at ${probe.where}: ${probe.detail}`);
    vscode.window.showErrorMessage(`Celiums: ${msg}`);
    return;
  }
  log.appendLine('[connect] probe ok — persisting credentials');

  await cfg.update(CFG_URL, url.trim(), vscode.ConfigurationTarget.Global);
  await ctx.secrets.store(SECRET_KEY, apiKey.trim());

  const result = await applyRegistration(detectHost(), { url: url.trim(), apiKey: apiKey.trim() }, ctx, log);
  log.appendLine(`[connect] applyRegistration → ${result.method}: ${result.detail}`);

  if (result.method === 'manual') {
    vscode.window.showWarningMessage(
      `Celiums: ${hostLabel(detectHost())} doesn't expose an MCP API. ` +
      `Manually add this MCP server: command=npx, args=[-y, @celiums/mcp@latest, --url, ${url}], env CELIUMS_API_KEY=<your key>.`,
      'Show logs',
    ).then((p) => { if (p === 'Show logs') log.show(true); });
  } else {
    vscode.window.showInformationMessage(
      `Celiums: connected to ${url} (${result.method}). Tools will appear in your editor's MCP panel.`,
      'Show logs',
    ).then((p) => { if (p === 'Show logs') log.show(true); });
  }

  await refreshStatus(ctx);
}

async function cmdDisconnect(ctx: vscode.ExtensionContext) {
  const host = detectHost();
  await ctx.secrets.delete(SECRET_KEY);
  await vscode.workspace.getConfiguration().update(CFG_URL, '', vscode.ConfigurationTarget.Global);

  await applyRegistration(host, undefined, ctx, log);
  log.appendLine('[disconnect] credentials cleared');

  await refreshStatus(ctx);
  vscode.window.showInformationMessage('Celiums: disconnected.');
}

async function cmdStatus(ctx: vscode.ExtensionContext) {
  const host = detectHost();
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);
  const native = hasNativeMcpApi();

  const lines: string[] = [
    `Host        : ${hostLabel(host)} (${vscode.env.appName} ${vscode.version})`,
    `Server URL  : ${url || '(not set)'}`,
    `API key     : ${apiKey ? '✓ stored' : '✗ missing'}`,
    `Native MCP  : ${native ? 'yes — provider registered' : 'no — using file-based or manual fallback'}`,
  ];

  vscode.window.showInformationMessage(
    lines.join('  ·  '),
    'Connect', 'Show logs', 'Open Dashboard',
  ).then((pick) => {
    if (pick === 'Connect') vscode.commands.executeCommand('celiums.connect');
    if (pick === 'Show logs') log.show(true);
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

interface Creds { url: string; apiKey: string; }

async function loadCreds(ctx: vscode.ExtensionContext): Promise<Creds | undefined> {
  const url = vscode.workspace.getConfiguration().get<string>(CFG_URL, '');
  const apiKey = await ctx.secrets.get(SECRET_KEY);
  if (!url || !apiKey) return undefined;
  return { url, apiKey };
}

async function refreshStatus(ctx: vscode.ExtensionContext) {
  const creds = await loadCreds(ctx);
  if (creds) {
    statusItem.text = '$(database) Celiums';
    statusItem.tooltip = `Connected to ${creds.url}`;
    statusItem.backgroundColor = undefined;
  } else {
    statusItem.text = '$(circle-slash) Celiums';
    statusItem.tooltip = 'Not connected — click to set up';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusItem.show();
}

async function getClient(ctx: vscode.ExtensionContext): Promise<CeliumsClient | null> {
  const cfg = vscode.workspace.getConfiguration();
  const creds = await loadCreds(ctx);
  if (!creds) {
    const pick = await vscode.window.showWarningMessage(
      'Celiums: not connected. Set up now?',
      'Connect',
    );
    if (pick === 'Connect') vscode.commands.executeCommand('celiums.connect');
    return null;
  }
  const userId = cfg.get<string>(CFG_USER, 'default') || 'default';
  return new CeliumsClient(creds.url, creds.apiKey, userId);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
