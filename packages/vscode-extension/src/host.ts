// Detects which IDE is running this extension and returns a stable
// label. VSCode and Antigravity expose `vscode.lm.registerMcpServerDefinitionProvider`
// natively; Cursor reads `~/.cursor/mcp.json` instead.

import * as vscode from 'vscode';

export type Host = 'vscode' | 'cursor' | 'antigravity' | 'unknown';

export function detectHost(): Host {
  const name = (vscode.env.appName || '').toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('antigravity')) return 'antigravity';
  if (name.includes('visual studio code') || name.includes('code - insiders')) return 'vscode';
  return 'unknown';
}

export function hostLabel(h: Host): string {
  return ({
    vscode: 'VSCode',
    cursor: 'Cursor',
    antigravity: 'Antigravity',
    unknown: 'editor',
  } as const)[h];
}

// VSCode shipped the MCP definition provider API in 1.97 (Stable, Feb
// 2026). On older builds vscode.lm exists but the registration call
// is a no-op surface. We feature-detect at runtime so the extension
// stays installable on any 1.96+ host.
export function hasNativeMcpApi(): boolean {
  const lm = (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: unknown } }).lm;
  return typeof lm?.registerMcpServerDefinitionProvider === 'function';
}
