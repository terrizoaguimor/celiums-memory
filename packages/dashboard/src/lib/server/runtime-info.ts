/**
 * Runtime info — values produced by firstboot.sh and the engine itself,
 * exposed read-only to the dashboard so cards stop showing placeholders.
 *
 *   /root/.celiums/dashboard_url  — public *.trycloudflare.com URL
 *   package.json (root)           — current celiums-memory version
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_URL_PATH = process.env.CELIUMS_PUBLIC_URL_FILE
  ?? '/root/.celiums/dashboard_url';

let cachedVersion: string | null = null;

export async function getPublicUrl(): Promise<string> {
  // Env wins for dev/local overrides.
  if (process.env.CELIUMS_PUBLIC_URL) return process.env.CELIUMS_PUBLIC_URL.trim();
  try {
    const raw = await fs.readFile(PUBLIC_URL_PATH, 'utf8');
    return raw.trim();
  } catch {
    return '';
  }
}

export async function getVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  // Walk up from the dashboard package to find the monorepo root package.json.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, '..', '..', '..', '..', '..', 'package.json'), // build/server → repo root
    join(here, '..', '..', '..', 'package.json'),             // dev path
    '/opt/celiums-memory/package.json',                       // installed-snapshot path
  ]) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const v = JSON.parse(raw).version;
      if (typeof v === 'string') {
        cachedVersion = v;
        return v;
      }
    } catch { /* try next */ }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}
