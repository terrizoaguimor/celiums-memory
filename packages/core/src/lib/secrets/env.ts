// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * EnvSecretProvider — default, zero-config backend.
 *
 * Looks up `name` in `process.env`. Optional prefix mapping (e.g.
 * `db.password` → `CELIUMS_DB_PASSWORD`) is supported because some
 * deployments prefer the env-var convention.
 *
 * Rotation and audit are NOT supported. This is documented and the
 * absence of those methods is part of the interface contract.
 */

import type { SecretProvider } from './types.js';
import { SecretNotFound } from './types.js';

export interface EnvProviderOptions {
  /** When set, secret names are upper-cased + non-alnum replaced with `_`
   *  and prepended with this prefix. e.g. prefix='CELIUMS_', name='db.host'
   *  → env var 'CELIUMS_DB_HOST'. */
  prefix?: string;
  /** Inject a custom env object (tests). */
  env?: NodeJS.ProcessEnv;
}

export class EnvSecretProvider implements SecretProvider {
  readonly id = 'env' as const;
  readonly name = 'Environment Variables';

  constructor(private readonly opts: EnvProviderOptions = {}) {}

  async get(name: string): Promise<string> {
    const env = this.opts.env ?? process.env;
    const direct = env[name];
    if (direct !== undefined && direct !== '') return direct;

    if (this.opts.prefix) {
      const mapped = this.opts.prefix + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const mapValue = env[mapped];
      if (mapValue !== undefined && mapValue !== '') return mapValue;
    }
    throw new SecretNotFound(name, this.id);
  }

  async healthy(): Promise<boolean> {
    return true; // env is always available
  }
}
