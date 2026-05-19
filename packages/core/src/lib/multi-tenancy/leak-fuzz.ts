// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Cross-tenant leak fuzz harness — ADR-009 §"Anti-leak protections" #4.
 *
 * Used both in unit tests (with a fake store) and in CI integration
 * tests (against a real Postgres + RLS-enabled tables).
 *
 * The harness is store-agnostic — the caller provides a writer + a
 * reader pair, plus a list of synthetic tenant ids. For each tenant we
 * write N records, then iterate over all tenants and assert that a
 * read from tenant A returns exactly the records written for tenant A
 * and zero records written for any B ≠ A.
 *
 * A leak is FATAL — the harness returns a structured report so CI can
 * fail with a clear message naming the leaking pairs.
 */

import { withRequestContext } from '../context/storage.js';
import type { RequestContext } from '../context/types.js';
import type { Principal } from '../auth/types.js';

export interface LeakHarnessOptions<R> {
  /** Synthetic tenant ids to populate. Use uuid v4. */
  tenantIds: string[];
  /** Records per tenant. Default 5. */
  recordsPerTenant?: number;
  /** Write a tagged record under the current request context. The
   *  harness wraps the call in a context whose tenantId is in
   *  `tenantIds`. Returns nothing — the harness assumes success. */
  writer: (tag: string) => Promise<void>;
  /** Read every record visible to the current request context. */
  reader: () => Promise<R[]>;
  /** Extract a stable identifier (the tag passed to the writer) from
   *  whatever the reader returns. */
  tagOf: (record: R) => string;
}

export interface LeakReport {
  leaks: Array<{
    readerTenant: string;
    leakedTag: string;
    expectedTenant: string;
  }>;
  missing: Array<{
    readerTenant: string;
    missingTag: string;
  }>;
  totals: {
    tenants: number;
    recordsPerTenant: number;
    expectedReads: number;
    observedReads: number;
  };
}

function makeCtx(tenantId: string): RequestContext {
  const principal: Principal = {
    type: 'service',
    userId: 'svc:leak-harness',
    tenantId,
    scopes: [],
    authMethod: 'local',
  };
  return {
    principal,
    tenantId,
    requestId: 'fuzz-' + Math.random().toString(36).slice(2, 10),
    traceId: '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01',
    startedAt: new Date(),
  };
}

export async function runLeakFuzz<R>(opts: LeakHarnessOptions<R>): Promise<LeakReport> {
  const N = opts.recordsPerTenant ?? 5;

  // Phase 1: write — `tag` = `<tenantId>::<idx>` so leaks are easy to
  // diagnose.
  for (const t of opts.tenantIds) {
    await withRequestContext(makeCtx(t), async () => {
      for (let i = 0; i < N; i++) {
        await opts.writer(`${t}::${i}`);
      }
    });
  }

  // Phase 2: read — for each tenant, the reader should see exactly its
  // own N records and zero from any other tenant.
  const leaks: LeakReport['leaks'] = [];
  const missing: LeakReport['missing'] = [];
  let observedReads = 0;

  for (const t of opts.tenantIds) {
    const observed = await withRequestContext(makeCtx(t), async () => opts.reader());
    observedReads += observed.length;
    const observedTags = new Set(observed.map((r) => opts.tagOf(r)));

    // Expected = N tags belonging to this tenant.
    for (let i = 0; i < N; i++) {
      const expectedTag = `${t}::${i}`;
      if (!observedTags.has(expectedTag)) {
        missing.push({ readerTenant: t, missingTag: expectedTag });
      }
    }

    // Anything observed that doesn't start with `${t}::` is a leak.
    for (const tag of observedTags) {
      if (!tag.startsWith(`${t}::`)) {
        const idx = tag.indexOf('::');
        const expectedTenant = idx > 0 ? tag.slice(0, idx) : '<unknown>';
        leaks.push({ readerTenant: t, leakedTag: tag, expectedTenant });
      }
    }
  }

  return {
    leaks,
    missing,
    totals: {
      tenants: opts.tenantIds.length,
      recordsPerTenant: N,
      expectedReads: opts.tenantIds.length * N,
      observedReads,
    },
  };
}

/** Pretty-print a report for CI logs. */
export function formatLeakReport(r: LeakReport): string {
  const lines = [
    `Tenants: ${r.totals.tenants}, records/tenant: ${r.totals.recordsPerTenant}`,
    `Expected reads: ${r.totals.expectedReads}, observed: ${r.totals.observedReads}`,
    `Leaks: ${r.leaks.length}`,
    `Missing: ${r.missing.length}`,
  ];
  if (r.leaks.length > 0) {
    lines.push('--- LEAKS ---');
    for (const l of r.leaks.slice(0, 20)) {
      lines.push(`  tenant ${l.readerTenant} saw tag ${l.leakedTag} (expected: ${l.expectedTenant})`);
    }
    if (r.leaks.length > 20) lines.push(`  …and ${r.leaks.length - 20} more`);
  }
  if (r.missing.length > 0) {
    lines.push('--- MISSING ---');
    for (const m of r.missing.slice(0, 20)) {
      lines.push(`  tenant ${m.readerTenant} did not see tag ${m.missingTag}`);
    }
    if (r.missing.length > 20) lines.push(`  …and ${r.missing.length - 20} more`);
  }
  return lines.join('\n');
}
