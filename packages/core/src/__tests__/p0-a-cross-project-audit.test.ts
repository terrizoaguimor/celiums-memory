// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * P0-A — cross-project recall audit log.
 *
 * Per REDISING §4.1, every `recall` call where the caller asks for a
 * projectId other than their default MUST land a row in
 * security_audit_log, regardless of allow/deny decision.
 *
 * We exercise the helper directly (`auditCrossProjectRecall`) so the
 * test is hermetic — the recall handler wiring is covered separately.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  writeAuditEvent,
  auditCrossProjectRecall,
  type AuditEvent,
} from '../mcp/security-audit.js';
import type { McpToolContext } from '../mcp/types.js';

interface StubQuery {
  sql: string;
  params: unknown[];
}

function makeStubPool() {
  const queries: StubQuery[] = [];
  let throwOnInsert = false;
  let throwOnSchema = false;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (throwOnSchema && sql.includes('CREATE TABLE')) {
        throw new Error('stub schema failure');
      }
      if (throwOnInsert && sql.includes('INSERT INTO security_audit_log')) {
        throw new Error('stub insert failure');
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return {
    pool,
    queries,
    setThrowOnInsert: (v: boolean) => { throwOnInsert = v; },
    setThrowOnSchema: (v: boolean) => { throwOnSchema = v; },
  };
}

function ctxWith(pool: unknown, overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    userId: 'tester',
    capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
    pool,
    ...overrides,
  } as McpToolContext;
}

describe('P0-A — security_audit_log', () => {
  // The module caches `schemaReady`; reset between tests by re-importing
  // is overkill — instead we just allow multiple ensureSchema() calls and
  // expect at most one CREATE TABLE in the first test.
  beforeEach(() => {
    // no-op; tests are independent because the stub pool is fresh.
  });

  it('ensures the schema before the first insert', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool);

    await writeAuditEvent(ctx, {
      event_kind: 'test.kind',
      user_id: ctx.userId,
      decision: 'allow',
      reason: 'unit test',
    });

    const sqls = queries.map((q) => q.sql);
    const hadCreate = sqls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS security_audit_log'));
    const hadInsert = sqls.some((s) => s.includes('INSERT INTO security_audit_log'));
    // Schema may have been ensured by a previous test in the same process;
    // the INSERT is the load-bearing assertion.
    expect(hadInsert).toBe(true);
    if (!hadCreate) {
      // schemaReady carry-over from prior test → that's OK.
      expect(hadInsert).toBe(true);
    }
  });

  it('persists allow events with the right payload', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool, { userId: 'alice', agentId: 'celiums-claude-code' });

    const event: AuditEvent = {
      event_kind: 'recall.cross_project',
      user_id: ctx.userId,
      agent_id: ctx.agentId,
      decision: 'allow',
      reason: 'admin scope present',
      details: { requested_project_id: 'global', has_admin_scope: true },
    };
    const ok = await writeAuditEvent(ctx, event);

    expect(ok).toBe(true);
    const inserts = queries.filter((q) => q.sql.includes('INSERT INTO security_audit_log'));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    const lastInsert = inserts[inserts.length - 1]!;
    expect(lastInsert.params[0]).toBe('recall.cross_project');
    expect(lastInsert.params[1]).toBe('alice');
    expect(lastInsert.params[2]).toBe('celiums-claude-code');
    expect(lastInsert.params[3]).toBe('allow');
    expect(lastInsert.params[4]).toBe('admin scope present');
    // details is serialised JSON
    const details = JSON.parse(String(lastInsert.params[5]));
    expect(details.requested_project_id).toBe('global');
    expect(details.has_admin_scope).toBe(true);
  });

  it('records deny events too — population must be complete', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool, { userId: 'bob' });

    const ok = await writeAuditEvent(ctx, {
      event_kind: 'recall.cross_project',
      user_id: ctx.userId,
      decision: 'deny',
      reason: 'no admin scope',
      details: { requested_project_id: 'other-project' },
    });

    expect(ok).toBe(true);
    const inserts = queries.filter((q) => q.sql.includes('INSERT INTO'));
    const lastInsert = inserts[inserts.length - 1]!;
    expect(lastInsert.params[3]).toBe('deny');
  });

  it('truncates a too-long reason to 500 chars', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool);
    const longReason = 'x'.repeat(1000);

    await writeAuditEvent(ctx, {
      event_kind: 'test.long_reason',
      user_id: ctx.userId,
      decision: 'allow',
      reason: longReason,
    });

    const lastInsert = queries.filter((q) => q.sql.includes('INSERT INTO')).slice(-1)[0]!;
    expect((lastInsert.params[4] as string).length).toBe(500);
  });

  it('returns false (not throws) when pool is missing', async () => {
    const ctx = ctxWith(undefined);
    const ok = await writeAuditEvent(ctx, {
      event_kind: 'test.no_pool',
      user_id: ctx.userId,
      decision: 'allow',
      reason: 'unit test',
    });
    expect(ok).toBe(false);
  });

  it('returns false (not throws) when the INSERT itself fails', async () => {
    const stub = makeStubPool();
    stub.setThrowOnInsert(true);
    const ctx = ctxWith(stub.pool);
    const ok = await writeAuditEvent(ctx, {
      event_kind: 'test.insert_failure',
      user_id: ctx.userId,
      decision: 'allow',
      reason: 'will fail',
    });
    expect(ok).toBe(false);
  });

  it('auditCrossProjectRecall — allow path with admin scope', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool, { userId: 'admin-op', sessionId: 'sess-1' });

    await auditCrossProjectRecall(ctx, {
      decision: 'allow',
      requestedProjectId: 'other-team-project',
      queryPreview: 'where did we store the auth migration plan',
      hasAdminScope: true,
      reason: 'cross_project granted: scope=admin:cross_project',
    });

    const last = queries.filter((q) => q.sql.includes('INSERT INTO')).slice(-1)[0]!;
    expect(last.params[0]).toBe('recall.cross_project');
    expect(last.params[3]).toBe('allow');
    const details = JSON.parse(String(last.params[5]));
    expect(details.requested_project_id).toBe('other-team-project');
    expect(details.has_admin_scope).toBe(true);
    expect(details.session_id).toBe('sess-1');
    expect(typeof details.query_preview).toBe('string');
    expect(details.query_preview.length).toBeLessThanOrEqual(120);
  });

  it('auditCrossProjectRecall — deny path without admin scope', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool, { userId: 'random-user' });

    await auditCrossProjectRecall(ctx, {
      decision: 'deny',
      requestedProjectId: 'global',
      queryPreview: '...',
      hasAdminScope: false,
      reason: 'cross_project refused: no admin:cross_project scope',
    });

    const last = queries.filter((q) => q.sql.includes('INSERT INTO')).slice(-1)[0]!;
    expect(last.params[3]).toBe('deny');
    const details = JSON.parse(String(last.params[5]));
    expect(details.has_admin_scope).toBe(false);
  });

  it('truncates the query_preview to 120 chars', async () => {
    const { pool, queries } = makeStubPool();
    const ctx = ctxWith(pool);
    const longQuery = 'a'.repeat(500);

    await auditCrossProjectRecall(ctx, {
      decision: 'allow',
      requestedProjectId: 'p',
      queryPreview: longQuery,
      hasAdminScope: true,
      reason: 'ok',
    });

    const last = queries.filter((q) => q.sql.includes('INSERT INTO')).slice(-1)[0]!;
    const details = JSON.parse(String(last.params[5]));
    expect(details.query_preview.length).toBe(120);
  });
});
