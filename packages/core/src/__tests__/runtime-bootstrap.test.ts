// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Tests — bootstrapRuntimeFromEnv.
 *
 * Coverage focused on the routing + safety properties — the actual
 * adapter wiring against real PG/SQLite/Qdrant is exercised by the
 * smoke-* tests. Here we verify:
 *
 *   - in-memory default when no env hints
 *   - sqlite path when CELIUMS_SQLITE_PATH set
 *   - banner contains masked DATABASE_URL (no plaintext creds)
 *   - sync mode default = local-only
 *   - cloud-synced WITHOUT passphrase throws (anti-pattern refusal)
 *   - warning emitted when confirm token secret missing
 *   - returned RuntimeContext has wired storage + sync + aal
 */

import { describe, it, expect } from 'vitest';
import { bootstrapRuntimeFromEnv } from '../index.js';

describe('bootstrapRuntimeFromEnv', () => {
  it('defaults to in-memory + local-only when no env hints', async () => {
    const r = await bootstrapRuntimeFromEnv({});
    expect(r.selection.adapter).toBe('in-memory');
    expect(r.syncMode).toBe('local-only');
    expect(r.runtime.storage).toBeTruthy();
    expect(r.runtime.sync.mode).toBe('local-only');
    expect(r.runtime.aal).toBeTruthy();
    expect(r.banner.some((l) => l.includes('in-memory'))).toBe(true);
  });

  it('selects sqlite when CELIUMS_SQLITE_PATH is set', async () => {
    const r = await bootstrapRuntimeFromEnv({
      CELIUMS_SQLITE_PATH: ':memory:',
    });
    expect(r.selection.adapter).toBe('sqlite');
    expect(r.runtime.storage.id).toBe('sqlite');
    expect(r.banner.some((l) => l.includes('sqlite'))).toBe(true);
    expect(r.banner.some((l) => l.includes(':memory:'))).toBe(true);
    await r.adapter.close();
  });

  it('cloud-synced without CELIUMS_ZK_PASSPHRASE throws (anti-pattern)', async () => {
    await expect(bootstrapRuntimeFromEnv({
      CELIUMS_SYNC_MODE: 'cloud-synced',
    })).rejects.toThrow(/CELIUMS_ZK_PASSPHRASE/);
  });

  it('cloud-synced with passphrase wires ZkSyncEngine', async () => {
    const r = await bootstrapRuntimeFromEnv({
      CELIUMS_SYNC_MODE: 'cloud-synced',
      CELIUMS_ZK_PASSPHRASE: 'test-pass',
    });
    expect(r.syncMode).toBe('cloud-synced');
    expect(r.runtime.sync.mode).toBe('cloud-synced');
  });

  it('cloud-managed mode wires plaintext engine', async () => {
    const r = await bootstrapRuntimeFromEnv({
      CELIUMS_SYNC_MODE: 'cloud-managed',
    });
    expect(r.syncMode).toBe('cloud-managed');
    expect(r.runtime.sync.mode).toBe('cloud-managed');
  });

  it('emits warning when confirm token secret is unset', async () => {
    const r = await bootstrapRuntimeFromEnv({});
    expect(r.banner.some((l) => l.includes('CELIUMS_CONFIRM_TOKEN_SECRET'))).toBe(true);
  });

  it('does NOT warn when confirm token secret is set', async () => {
    const r = await bootstrapRuntimeFromEnv({
      CELIUMS_CONFIRM_TOKEN_SECRET: 'prod-secret-from-vault',
    });
    expect(r.banner.some((l) => l.includes('CELIUMS_CONFIRM_TOKEN_SECRET'))).toBe(false);
  });

  it('CELIUMS_STORAGE_ADAPTER override is honored', async () => {
    const r = await bootstrapRuntimeFromEnv({
      CELIUMS_STORAGE_ADAPTER: 'in-memory',
      DATABASE_URL: 'postgres://x:y@h:5432/d', // would normally pick pg-triple
    });
    expect(r.selection.adapter).toBe('in-memory');
  });

  it('banner masks DATABASE_URL credentials when pg adapter is chosen', async () => {
    // bootstrap is construction-only — does not connect. We verify
    // the banner string masks creds and the adapter exists; init()
    // is the caller's responsibility.
    const env = {
      CELIUMS_STORAGE_ADAPTER: 'pg',
      DATABASE_URL: 'postgresql://celiums:hunter2@db.internal:5432/celiums_memory',
      QDRANT_URL: 'http://qdrant:6333',
    };
    const r = await bootstrapRuntimeFromEnv(env);
    const bannerLine = r.banner.find((l) => l.includes('database=')) ?? '';
    expect(bannerLine).toContain('***:***@');
    expect(bannerLine).not.toContain('hunter2');
    expect(r.adapter.id).toBe('pg-triple');
    // Cleanup the lazily-created pool so vitest doesn't hang
    const adapter = r.adapter as any;
    if (adapter.opts?.pool?.end) await adapter.opts.pool.end();
  });
});
