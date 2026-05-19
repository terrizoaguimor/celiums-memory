// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * FileSecretProvider — reads secrets from a directory or a dotenv file.
 *
 * Two modes:
 *
 * 1. **Directory mode** (one secret per file). The file basename is the
 *    secret name; the file contents (trimmed) are the value. This is
 *    the K8s-mounted-Secret convention and the SOPS encrypted-file
 *    convention, so the same code path serves both.
 *
 * 2. **Dotenv mode** (one file, many `KEY=value` lines). Quoted values
 *    and lines starting with `#` are handled.
 *
 * For SOPS-encrypted files, the deployment is expected to have decrypted
 * them at startup time (Kustomize SOPS plugin, `sops -d`, age-tool, etc.)
 * — the provider does NOT shell out to `sops` itself; that would add a
 * dependency. Operators wire SOPS at the platform layer.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretProvider } from './types.js';
import { SecretNotFound, SecretBackendUnavailable } from './types.js';

export interface FileProviderOptions {
  /** A directory of `name → contents` files, or a single dotenv file. */
  path: string;
  /** When `path` is a single file, force dotenv parsing. Defaults to
   *  auto-detect: a directory → directory mode; a regular file → dotenv. */
  mode?: 'directory' | 'dotenv';
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export class FileSecretProvider implements SecretProvider {
  readonly id = 'file' as const;
  readonly name: string;
  private readonly mode: 'directory' | 'dotenv';
  private readonly cache = new Map<string, string>();
  private cacheLoaded = false;

  constructor(private readonly opts: FileProviderOptions) {
    if (!opts.path) {
      throw new SecretBackendUnavailable(this.id, 'path is required');
    }
    if (!existsSync(opts.path)) {
      throw new SecretBackendUnavailable(this.id, `path does not exist: ${opts.path}`);
    }
    let detected: 'directory' | 'dotenv';
    try {
      const st = statSync(opts.path);
      detected = st.isDirectory() ? 'directory' : 'dotenv';
    } catch (e) {
      throw new SecretBackendUnavailable(this.id, `stat failed: ${(e as Error).message}`);
    }
    this.mode = opts.mode ?? detected;
    this.name = `File (${this.mode}, ${opts.path})`;
  }

  private loadDotenvOnce(): void {
    if (this.cacheLoaded) return;
    try {
      const text = readFileSync(this.opts.path, 'utf8');
      const parsed = parseDotenv(text);
      for (const [k, v] of Object.entries(parsed)) this.cache.set(k, v);
    } catch (e) {
      throw new SecretBackendUnavailable(this.id, `read failed: ${(e as Error).message}`);
    }
    this.cacheLoaded = true;
  }

  async get(name: string): Promise<string> {
    if (this.mode === 'dotenv') {
      this.loadDotenvOnce();
      const v = this.cache.get(name);
      if (v === undefined || v === '') throw new SecretNotFound(name, this.id);
      return v;
    }
    // Directory mode: read on demand. K8s rotates the file in-place; we
    // do NOT cache so a rotation is picked up on the next read.
    const file = join(this.opts.path, name);
    if (!existsSync(file)) throw new SecretNotFound(name, this.id);
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (e) {
      throw new SecretBackendUnavailable(this.id, `read ${file}: ${(e as Error).message}`);
    }
  }

  async healthy(): Promise<boolean> {
    try {
      // In directory mode, the dir is readable iff readdir succeeds.
      if (this.mode === 'directory') {
        readdirSync(this.opts.path);
      } else {
        statSync(this.opts.path);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Test helper — drop the cache so a subsequent get() re-reads. */
  _clearCacheForTests(): void {
    this.cache.clear();
    this.cacheLoaded = false;
  }
}

/** Helper for tests + admin scripts. */
export { parseDotenv };
