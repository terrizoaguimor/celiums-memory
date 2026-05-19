// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * RemoteModuleStore — HTTP proxy to a knowledge backend.
 *
 * Context: this backend does not ship a bundled knowledge DB. It is a
 * thin HTTP proxy to whatever knowledge/skills backend the operator
 * configures (`KNOWLEDGE_API_URL`). Bring your own knowledge — the
 * large curated corpus is a separate project, not part of this OSS
 * engine.
 *
 * This class implements the exact ModuleStore surface that `lib/opencore.ts`
 * (forage / absorb / sense / mapNetwork) and the `/v1/modules*` /
 * `/v1/categories` / `/v1/search` REST handlers expect, so wiring it into
 * `ctx.moduleStore` makes everything work without touching the call sites.
 *
 * Env:
 *   KNOWLEDGE_API_URL  — base URL of the knowledge backend.
 *                        Default: https://memory.celiums.ai
 *   KNOWLEDGE_API_KEY  — service key valid at that host (Bearer).
 */

export interface RemoteModuleStoreOptions {
  baseUrl: string;
  apiKey: string;
}

export interface ModuleRow {
  name: string;
  displayName?: string;
  category?: string;
  evalScore?: number | null;
  description?: string;
  lineCount?: number | null;
  keywords?: string[];
  content?: { content?: string } | string | null;
}

export interface IndexShape {
  totalModules: number;
  categories: Record<string, number>;
}

export class RemoteModuleStore {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: RemoteModuleStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      const err: { message: string; code?: number } = new Error(
        `knowledge upstream ${res.status} for ${path}`,
      );
      err.code = -32603;
      throw err;
    }
    return res.json();
  }

  // ── ModuleStore surface ────────────────────────────────────────────

  async searchFullText(query: string, limit: number): Promise<ModuleRow[]> {
    const data = (await this.get(
      `/v1/modules?q=${encodeURIComponent(query)}&limit=${limit}`,
    )) as { modules?: ModuleRow[] };
    return Array.isArray(data?.modules) ? data.modules.slice(0, limit) : [];
  }

  async getByCategory(category: string, limit: number): Promise<ModuleRow[]> {
    const data = (await this.get(
      `/v1/modules?category=${encodeURIComponent(category)}&limit=${limit}`,
    )) as { modules?: ModuleRow[] };
    return Array.isArray(data?.modules) ? data.modules.slice(0, limit) : [];
  }

  /** No dedicated by-name endpoint upstream — full-text covers it. */
  async searchByName(query: string, limit: number): Promise<ModuleRow[]> {
    return this.searchFullText(query, limit);
  }

  async getIndex(): Promise<IndexShape> {
    const data = (await this.get('/v1/modules')) as IndexShape;
    const total = typeof data?.totalModules === 'number' ? data.totalModules : 0;
    const categories = data?.categories ?? {};
    return { totalModules: total, categories };
  }

  async getModule(name: string): Promise<ModuleRow | null> {
    let mod: ModuleRow;
    try {
      mod = (await this.get(
        `/v1/modules/${encodeURIComponent(name)}?full=true`,
      )) as ModuleRow;
    } catch (e) {
      if ((e as { message?: string }).message?.includes('404')) return null;
      throw e;
    }
    if (!mod) return null;
    // Normalize content to { content: string }.
    const rawContent =
      typeof mod.content === 'string'
        ? mod.content
        : mod.content?.content ?? '';
    return { ...mod, content: { content: rawContent } };
  }

  async getModuleMeta(name: string): Promise<ModuleRow | null> {
    try {
      const mod = (await this.get(
        `/v1/modules/${encodeURIComponent(name)}?full=false`,
      )) as ModuleRow;
      return mod ?? null;
    } catch (e) {
      if ((e as { message?: string }).message?.includes('404')) return null;
      throw e;
    }
  }

  async health(): Promise<{ ok: boolean; remote: string; totalModules?: number }> {
    try {
      const idx = (await this.get('/v1/modules')) as IndexShape;
      return {
        ok: true,
        remote: this.baseUrl,
        totalModules: idx?.totalModules,
      };
    } catch {
      return { ok: false, remote: this.baseUrl };
    }
  }
}

/**
 * Build a RemoteModuleStore from env, or null if disabled.
 * Returns null when KNOWLEDGE_API_KEY is absent (can't proxy) — keeps
 * the "knowledge_unavailable" 503 path for fully-offline installs that
 * have no knowledge backend configured.
 */
export function buildRemoteModuleStore(
  env: NodeJS.ProcessEnv = process.env,
): RemoteModuleStore | null {
  const apiKey = env['KNOWLEDGE_API_KEY'];
  if (!apiKey) return null;
  const baseUrl = env['KNOWLEDGE_API_URL'] || 'https://memory.celiums.ai';
  return new RemoteModuleStore({ baseUrl, apiKey });
}
