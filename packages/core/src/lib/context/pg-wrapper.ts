// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Postgres pool wrapper — sets per-checkout session variables so RLS
 * (ADR-009) and audit logging always see the correct tenant.
 *
 * Every connection checkout runs:
 *   SET LOCAL app.current_tenant = $1;
 *   SET LOCAL app.current_user   = $2;
 *
 * Handler code is FORBIDDEN from using the raw `pg.Pool.query` —
 * imports must go through `withTenantClient()` or `tenantQuery()` so
 * the session vars are always set. We add the lint rule (forbid
 * `import { Pool } from 'pg'` outside this module) in a later sprint.
 *
 * Why SET LOCAL vs SET: LOCAL is scoped to the current transaction;
 * if we forget to RESET, the next checkout from the same backend
 * starts fresh. Belt-and-suspenders for tenant isolation.
 */

import { getRequestContextOrThrow } from './storage.js';

/** Subset of pg.Pool we need. Lets tests inject without depending on pg. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(err?: Error | boolean): void;
}

/** Acquire a client with `app.current_tenant` + `app.current_user` set.
 *  Caller MUST `release()` — use try/finally. */
export async function withTenantClient<T>(
  pool: PgPoolLike,
  fn: (client: PgClientLike) => Promise<T>,
): Promise<T> {
  const ctx = getRequestContextOrThrow();
  const client = await pool.connect();
  try {
    // Wrap the whole work in a transaction so SET LOCAL has scope. We
    // commit on success and ROLLBACK on error — handler code should
    // open its own savepoints if it needs finer control.
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = $1`, [ctx.tenantId]);
    await client.query(`SET LOCAL app.current_user = $1`, [ctx.principal.userId]);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      throw err;
    }
  } finally {
    client.release();
  }
}

/** One-shot query helper. Opens, sets, queries, releases. For
 *  handlers that need a single statement. */
export async function tenantQuery(
  pool: PgPoolLike,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: any[]; rowCount?: number | null }> {
  return withTenantClient(pool, async (client) => client.query(sql, params));
}

/** ADMIN ESCAPE — for platform-admin scheduled jobs that legitimately
 *  span tenants. Audit-logged at the call site. NEVER call this from a
 *  handler reachable by tenant-scoped principals. */
export async function withPlatformClient<T>(
  pool: PgPoolLike,
  reason: string,
  fn: (client: PgClientLike) => Promise<T>,
): Promise<T> {
  if (!reason || reason.length < 10) {
    throw new Error('withPlatformClient requires a reason ≥10 chars for audit trace');
  }
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
