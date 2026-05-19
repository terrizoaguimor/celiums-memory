// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * buildModuleStore — single entry point that picks the knowledge backend.
 *
 * Incident 2026-05-16 fix + Mario's single-service directive:
 *   DEFAULT = direct-DB (PgModuleStore over KNOWLEDGE_DATABASE_URL).
 *   The service answers to ONE user key, reads its own curated `skills`
 *   corpus directly. No self-proxy, no recursion.
 *
 *   ESCAPE HATCH = RemoteModuleStore, used ONLY when KNOWLEDGE_API_URL is
 *   explicitly set to a DISTINCT external host (a real federation/corpus
 *   service) AND a KNOWLEDGE_API_KEY is present. Pointing it at itself
 *   (memory.celiums.ai / localhost) is treated as "not external" so the
 *   recursion footgun is structurally impossible.
 *
 *   null (→ graceful 503) only for a fully-offline install with neither a
 *   DB nor an external host.
 *
 * Returns a structural ModuleStore (both classes expose the identical
 * surface searchFullText/getByCategory/searchByName/getIndex/getModule/
 * getModuleMeta/health), so callers stay unchanged.
 *
 * @license Apache-2.0
 */

import { RemoteModuleStore } from './remote-module-store.js';
import { PgModuleStore } from './pg-module-store.js';

export type ModuleStore = RemoteModuleStore | PgModuleStore;

/** A KNOWLEDGE_API_URL that points back at this service (or localhost) is
 *  NOT an external corpus host — using RemoteModuleStore there self-loops. */
function isExternalHost(url: string | undefined): boolean {
  if (!url) return false;
  const u = url.trim().toLowerCase();
  if (!/^https?:\/\//.test(u)) return false;
  if (u.includes('memory.celiums.ai')) return false; // self
  if (u.includes('localhost') || u.includes('127.0.0.1')) return false;
  return true;
}

export function buildModuleStore(
  env: NodeJS.ProcessEnv = process.env,
): ModuleStore | null {
  const dbUrl = env['KNOWLEDGE_DATABASE_URL'];
  const apiUrl = env['KNOWLEDGE_API_URL'];
  const apiKey = env['KNOWLEDGE_API_KEY'];

  // Escape hatch: a genuinely external corpus/federation host.
  if (isExternalHost(apiUrl) && apiKey) {
    return new RemoteModuleStore({ baseUrl: apiUrl as string, apiKey });
  }

  // Default single-service path: read the curated skills corpus directly.
  if (dbUrl) {
    return new PgModuleStore({ connectionString: dbUrl });
  }

  // Neither a DB nor a real external host → graceful unavailable.
  return null;
}
