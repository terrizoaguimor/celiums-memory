// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-024 — AAL Action Authority Layer tests.
 *
 * Coverage:
 *   - Blast-radius taxonomy: R1/R2 immediate allow, R3 confirm, R4/R5 approval
 *   - Scope-driven tier escalation (memory.delete < 100 → R3, < 10k → R4, ≥ 10k → R5)
 *   - Confirm token mechanics: mint, validate-and-consume, single-use, expiry,
 *     wrong user / wrong op / wrong scope rejected, bad signature rejected
 *   - In-memory ApprovalQueue + multi-party approval state machine,
 *     self-approval forbidden, idempotent re-approve, reject, expire
 *   - composeChecks composition: RBAC denial → throws; AAL allow_with_confirm
 *     surfaces verdict; AAL deny → throws AalDenied; Ethics block → throws
 *   - Override path: only platform-owner; non-owner throws AalOverrideDenied
 *   - Audit hook fires for every verdict + override
 *   - Unknown op kind falls back to UNKNOWN_DEFAULT_TIER
 *   - Cross-tenant blast forces minimum R4 even when kind unknown
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  // surface
  AalDenied, AalInvalidConfirmToken, AalOverrideDenied, RbacDenied,
  // policies
  DEFAULT_POLICIES, UNKNOWN_DEFAULT_TIER, DefaultPolicyProvider,
  // tokens
  MemoryTokenStore, makeConfirmTokenManager,
  // queue
  MemoryApprovalQueue, AAL_PENDING_SCHEMA_SQL,
  // audit
  NOOP_AUDIT_HOOK, makeAalAuditHook,
  // evaluator + composition
  DefaultAalEvaluator, composeChecks, AalEthicsBlocked,
  type AalAuditHook, type AalRequestContext, type AalOperation,
  type Principal, type RbacRole,
} from '../index.js';

function fakePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user', userId: 'alice', tenantId: 't1',
    scopes: [], authMethod: 'api_key', ...overrides,
  };
}

function makeEvaluator(opts: { audit?: AalAuditHook } = {}) {
  return new DefaultAalEvaluator({
    policies: new DefaultPolicyProvider(),
    confirmTokens: makeConfirmTokenManager({
      secret: 'test-secret',
      store: new MemoryTokenStore(),
    }),
    approvalQueue: new MemoryApprovalQueue(),
    ...(opts.audit ? { audit: opts.audit } : {}),
  });
}

function fakeCtx(overrides: Partial<AalRequestContext> = {}): AalRequestContext {
  return { principal: fakePrincipal(), ...overrides };
}

/* ──────────────────────────────────────────────────────────────────
 *  Blast-radius taxonomy + default policies
 * ────────────────────────────────────────────────────────────────── */

describe('DEFAULT_POLICIES', () => {
  it('R1 reads return immediate allow', async () => {
    const e = makeEvaluator();
    for (const kind of ['memory.recall', 'memory.forage', 'journal.recall']) {
      const v = await e.evaluate({ kind, scope: {} }, fakeCtx());
      expect(v.decision).toBe('allow');
      expect(v.tier).toBe('R1');
    }
  });

  it('R2 soft writes return immediate allow', async () => {
    const e = makeEvaluator();
    for (const kind of ['memory.remember', 'journal.write', 'memory.update']) {
      const v = await e.evaluate({ kind, scope: {} }, fakeCtx());
      expect(v.decision).toBe('allow');
      expect(v.tier).toBe('R2');
    }
  });

  it('memory.delete < 100 rows → R3 confirm', async () => {
    const e = makeEvaluator();
    const v = await e.evaluate(
      { kind: 'memory.delete', scope: { affectedRows: 50 } },
      fakeCtx(),
    );
    expect(v.decision).toBe('allow_with_confirm');
    expect(v.tier).toBe('R3');
    if (v.decision === 'allow_with_confirm') {
      expect(v.confirmToken).toMatch(/^cmk_conf_/);
      expect(v.ttlSeconds).toBe(300);
    }
  });

  it('memory.delete ∈ [100, 10k) → R4 with 1 approver', async () => {
    const e = makeEvaluator();
    const v = await e.evaluate(
      { kind: 'memory.delete', scope: { affectedRows: 1000 } },
      fakeCtx(),
    );
    expect(v.decision).toBe('allow_with_approval');
    expect(v.tier).toBe('R4');
    if (v.decision === 'allow_with_approval') {
      expect(v.approversRequired).toBe(1);
      expect(v.approvedBy).toEqual([]);
      expect(v.pendingOperationId).toBeTruthy();
    }
  });

  it('memory.delete ≥ 10k → R5 with 2 approvers', async () => {
    const e = makeEvaluator();
    const v = await e.evaluate(
      { kind: 'memory.delete', scope: { affectedRows: 50_000 } },
      fakeCtx(),
    );
    expect(v.decision).toBe('allow_with_approval');
    expect(v.tier).toBe('R5');
    if (v.decision === 'allow_with_approval') expect(v.approversRequired).toBe(2);
  });

  it('tenant.delete is always R5/2 regardless of scope', async () => {
    const e = makeEvaluator();
    const v = await e.evaluate(
      { kind: 'tenant.delete', scope: {} },
      fakeCtx(),
    );
    expect(v.tier).toBe('R5');
    if (v.decision === 'allow_with_approval') expect(v.approversRequired).toBe(2);
  });

  it('unknown op kind falls back to UNKNOWN_DEFAULT_TIER (R3)', async () => {
    const e = makeEvaluator();
    const v = await e.evaluate(
      { kind: 'gizmo.untracked_op', scope: {} },
      fakeCtx(),
    );
    expect(v.tier).toBe(UNKNOWN_DEFAULT_TIER);
    expect(v.tier).toBe('R3');
    expect(v.decision).toBe('allow_with_confirm');
  });

  it('unknown op + crossTenantBlast bumps to R4 minimum', async () => {
    const e = makeEvaluator();
    const v = await e.evaluate(
      { kind: 'gizmo.untracked_op', scope: { crossTenantBlast: true } },
      fakeCtx(),
    );
    expect(v.tier).toBe('R4');
    expect(v.decision).toBe('allow_with_approval');
  });

  it('every key in DEFAULT_POLICIES is callable and returns a tier', () => {
    for (const [kind, fn] of Object.entries(DEFAULT_POLICIES)) {
      const r = fn({ kind, scope: {} } as AalOperation, fakeCtx());
      expect(r.tier).toMatch(/^R[1-5]$/);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Confirm token mechanics
 * ────────────────────────────────────────────────────────────────── */

describe('Confirm tokens', () => {
  it('confirmed re-invocation flows R3 → allow', async () => {
    const e = makeEvaluator();
    const op = { kind: 'memory.delete', scope: { affectedRows: 10 } } as AalOperation;
    const first = await e.evaluate(op, fakeCtx());
    expect(first.decision).toBe('allow_with_confirm');
    if (first.decision !== 'allow_with_confirm') throw new Error('unreachable');

    const second = await e.evaluate(op, fakeCtx({ confirmToken: first.confirmToken }));
    expect(second.decision).toBe('allow');
    expect(second.tier).toBe('R3');
  });

  it('token is single-use — second consume denies', async () => {
    const e = makeEvaluator();
    const op = { kind: 'memory.delete', scope: { affectedRows: 10 } } as AalOperation;
    const first = await e.evaluate(op, fakeCtx());
    if (first.decision !== 'allow_with_confirm') throw new Error();
    const ok = await e.evaluate(op, fakeCtx({ confirmToken: first.confirmToken }));
    expect(ok.decision).toBe('allow');
    const reuse = await e.evaluate(op, fakeCtx({ confirmToken: first.confirmToken }));
    expect(reuse.decision).toBe('deny');
    expect(reuse.reason).toMatch(/already used/);
  });

  it('different user cannot consume the token', async () => {
    const e = makeEvaluator();
    const op = { kind: 'memory.delete', scope: { affectedRows: 10 } } as AalOperation;
    const first = await e.evaluate(op, fakeCtx({ principal: fakePrincipal({ userId: 'alice' }) }));
    if (first.decision !== 'allow_with_confirm') throw new Error();
    const wrongUser = await e.evaluate(op, fakeCtx({
      principal: fakePrincipal({ userId: 'mallory' }),
      confirmToken: first.confirmToken,
    }));
    expect(wrongUser.decision).toBe('deny');
    expect(wrongUser.reason).toMatch(/user mismatch/);
  });

  it('different scope cannot consume the token', async () => {
    const e = makeEvaluator();
    const opA = { kind: 'memory.delete', scope: { affectedRows: 10 } } as AalOperation;
    const opB = { kind: 'memory.delete', scope: { affectedRows: 11 } } as AalOperation;
    const minted = await e.evaluate(opA, fakeCtx());
    if (minted.decision !== 'allow_with_confirm') throw new Error();
    const wrongScope = await e.evaluate(opB, fakeCtx({ confirmToken: minted.confirmToken }));
    expect(wrongScope.decision).toBe('deny');
    expect(wrongScope.reason).toMatch(/scope mismatch/);
  });

  it('different op kind cannot consume the token (R3 → R3 cross-op)', async () => {
    const e = makeEvaluator();
    const a = { kind: 'memory.delete', scope: { affectedRows: 10 } } as AalOperation;
    const b = { kind: 'journal.redact', scope: {} } as AalOperation;
    const minted = await e.evaluate(a, fakeCtx());
    if (minted.decision !== 'allow_with_confirm') throw new Error();
    const wrongOp = await e.evaluate(b, fakeCtx({ confirmToken: minted.confirmToken }));
    expect(wrongOp.decision).toBe('deny');
    expect(wrongOp.reason).toMatch(/operation mismatch/);
  });

  it('tampered signature is rejected', async () => {
    const e = makeEvaluator();
    const op = { kind: 'memory.delete', scope: { affectedRows: 10 } } as AalOperation;
    const minted = await e.evaluate(op, fakeCtx());
    if (minted.decision !== 'allow_with_confirm') throw new Error();
    const tampered = minted.confirmToken.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const denied = await e.evaluate(op, fakeCtx({ confirmToken: tampered }));
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toMatch(/bad signature/);
  });

  it('hashScope is stable across object key orderings', async () => {
    // Two managers / stores so a deterministic identical token doesn't
    // poison the single-use store. We're testing scope-hash stability,
    // not token uniqueness.
    const mgrA = makeConfirmTokenManager({ secret: 's', store: new MemoryTokenStore() });
    const mgrB = makeConfirmTokenManager({ secret: 's', store: new MemoryTokenStore() });
    const t1 = mgrA.mint({ userId: 'u', opKind: 'k', scope: { a: 1, b: 2 } });
    const t2 = mgrB.mint({ userId: 'u', opKind: 'k', scope: { b: 2, a: 1 } });
    const r1 = await mgrA.validateAndConsume({ token: t1, userId: 'u', opKind: 'k', scope: { b: 2, a: 1 } });
    const r2 = await mgrB.validateAndConsume({ token: t2, userId: 'u', opKind: 'k', scope: { a: 1, b: 2 } });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('expired token is rejected', async () => {
    const mgr = makeConfirmTokenManager({
      secret: 'k',
      store: new MemoryTokenStore(),
      defaultTtlSeconds: -1,
    });
    const token = mgr.mint({ userId: 'u', opKind: 'k', scope: {} });
    const r = await mgr.validateAndConsume({ token, userId: 'u', opKind: 'k', scope: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Approval queue
 * ────────────────────────────────────────────────────────────────── */

describe('MemoryApprovalQueue', () => {
  it('R4 op gets enqueued; 1 approval flips to approved', async () => {
    const q = new MemoryApprovalQueue();
    const op: AalOperation = { kind: 'memory.delete', scope: { affectedRows: 200 } };
    const p = await q.enqueue({
      op, tier: 'R4', approversRequired: 1,
      requesterUserId: 'alice', requesterTenantId: 't1',
    });
    expect(p.status).toBe('pending');
    const approved = await q.approve({ id: p.id, approverUserId: 'admin1' });
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toEqual(['admin1']);
  });

  it('R5 op needs 2 distinct approvers', async () => {
    const q = new MemoryApprovalQueue();
    const p = await q.enqueue({
      op: { kind: 'tenant.delete', scope: {} },
      tier: 'R5', approversRequired: 2,
      requesterUserId: 'alice', requesterTenantId: 't1',
    });
    const after1 = await q.approve({ id: p.id, approverUserId: 'admin1' });
    expect(after1.status).toBe('pending');
    const after2 = await q.approve({ id: p.id, approverUserId: 'admin2' });
    expect(after2.status).toBe('approved');
    expect(after2.approvedBy).toEqual(['admin1', 'admin2']);
  });

  it('self-approval is forbidden', async () => {
    const q = new MemoryApprovalQueue();
    const p = await q.enqueue({
      op: { kind: 'tenant.delete', scope: {} },
      tier: 'R5', approversRequired: 2,
      requesterUserId: 'alice', requesterTenantId: 't1',
    });
    await expect(q.approve({ id: p.id, approverUserId: 'alice' }))
      .rejects.toThrow(/self-approval forbidden/);
  });

  it('idempotent re-approve by the same user', async () => {
    const q = new MemoryApprovalQueue();
    const p = await q.enqueue({
      op: { kind: 'tenant.delete', scope: {} },
      tier: 'R5', approversRequired: 2,
      requesterUserId: 'alice', requesterTenantId: 't1',
    });
    const a = await q.approve({ id: p.id, approverUserId: 'admin1' });
    const b = await q.approve({ id: p.id, approverUserId: 'admin1' });
    expect(a.approvedBy).toEqual(['admin1']);
    expect(b.approvedBy).toEqual(['admin1']);
    expect(b.status).toBe('pending');
  });

  it('reject flips status to rejected', async () => {
    const q = new MemoryApprovalQueue();
    const p = await q.enqueue({
      op: { kind: 'tenant.delete', scope: {} },
      tier: 'R5', approversRequired: 2,
      requesterUserId: 'alice', requesterTenantId: 't1',
    });
    const r = await q.reject({ id: p.id, approverUserId: 'admin1', reason: 'no thanks' });
    expect(r.status).toBe('rejected');
    expect(r.decisionReason).toMatch(/admin1: no thanks/);
  });

  it('expireDue moves due pending entries to expired', async () => {
    const q = new MemoryApprovalQueue();
    const p = await q.enqueue({
      op: { kind: 'tenant.delete', scope: {} },
      tier: 'R5', approversRequired: 2,
      requesterUserId: 'alice', requesterTenantId: 't1',
      expiresInSeconds: -1,
    });
    const n = await q.expireDue();
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await q.get(p.id);
    expect(after?.status).toBe('expired');
  });

  it('R4/R5 reinvoke with approvedPendingId returns allow', async () => {
    const queue = new MemoryApprovalQueue();
    const e = new DefaultAalEvaluator({
      policies: new DefaultPolicyProvider(),
      confirmTokens: makeConfirmTokenManager({ secret: 'k', store: new MemoryTokenStore() }),
      approvalQueue: queue,
    });
    const op: AalOperation = { kind: 'tenant.delete', scope: {} };
    const v1 = await e.evaluate(op, fakeCtx());
    if (v1.decision !== 'allow_with_approval') throw new Error();
    await queue.approve({ id: v1.pendingOperationId, approverUserId: 'admin1' });
    await queue.approve({ id: v1.pendingOperationId, approverUserId: 'admin2' });
    const v2 = await e.evaluate(op, fakeCtx({ approvedPendingId: v1.pendingOperationId }));
    expect(v2.decision).toBe('allow');
    expect(v2.reason).toMatch(/approved by admin1,admin2/);
  });

  it('R4/R5 reinvoke with pending-not-approved still denies', async () => {
    const queue = new MemoryApprovalQueue();
    const e = new DefaultAalEvaluator({
      policies: new DefaultPolicyProvider(),
      confirmTokens: makeConfirmTokenManager({ secret: 'k', store: new MemoryTokenStore() }),
      approvalQueue: queue,
    });
    const op: AalOperation = { kind: 'tenant.delete', scope: {} };
    const v1 = await e.evaluate(op, fakeCtx());
    if (v1.decision !== 'allow_with_approval') throw new Error();
    // do not approve
    const v2 = await e.evaluate(op, fakeCtx({ approvedPendingId: v1.pendingOperationId }));
    expect(v2.decision).toBe('deny');
    expect(v2.reason).toMatch(/status is 'pending'/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  composeChecks composition
 * ────────────────────────────────────────────────────────────────── */

describe('composeChecks', () => {
  it('RBAC denial throws before AAL runs', async () => {
    let aalCalled = false;
    const aal = {
      async evaluate() {
        aalCalled = true;
        return { decision: 'allow' as const, tier: 'R1' as const, reason: '' };
      },
    };
    await expect(composeChecks({
      role: 'tenant-viewer' as RbacRole,
      principal: fakePrincipal(),
      op: {
        aalKind: 'tenant.delete',
        capability: 'tenant:delete' as any,
        scope: {},
      },
      ctx: fakeCtx(),
      aal,
    })).rejects.toThrow(RbacDenied);
    expect(aalCalled).toBe(false);
  });

  it('AAL deny throws AalDenied', async () => {
    const aal = {
      async evaluate() {
        return { decision: 'deny' as const, tier: 'R5' as const, reason: 'forbidden' };
      },
    };
    await expect(composeChecks({
      role: 'platform-owner' as RbacRole,
      principal: fakePrincipal(),
      op: {
        aalKind: 'tenant.delete',
        capability: 'platform:tenants:delete' as any,
        scope: {},
      },
      ctx: fakeCtx(),
      aal,
    })).rejects.toThrow(AalDenied);
  });

  it('AAL allow_with_confirm surfaces verdict without throwing', async () => {
    const e = makeEvaluator();
    const v = await composeChecks({
      role: 'tenant-admin' as RbacRole,
      principal: fakePrincipal(),
      op: {
        aalKind: 'memory.delete',
        capability: 'memory:write' as any,
        scope: { affectedRows: 1 },
      },
      ctx: fakeCtx(),
      aal: e,
    });
    expect(v.decision).toBe('allow_with_confirm');
  });

  it('Ethics block throws when content is present', async () => {
    const e = makeEvaluator();
    await expect(composeChecks({
      role: 'tenant-admin' as RbacRole,
      principal: fakePrincipal(),
      op: {
        aalKind: 'memory.remember',
        capability: 'memory:write' as any,
        scope: {},
        content: 'something violating',
      },
      ctx: fakeCtx(),
      aal: e,
      opts: {
        evaluateEthics: async () => ({ decision: 'block', reason: 'pii leak' }),
      },
    })).rejects.toThrow(AalEthicsBlocked);
  });

  it('Ethics flag is non-blocking', async () => {
    const e = makeEvaluator();
    const v = await composeChecks({
      role: 'tenant-admin' as RbacRole,
      principal: fakePrincipal(),
      op: {
        aalKind: 'memory.remember',
        capability: 'memory:write' as any,
        scope: {},
        content: 'borderline',
      },
      ctx: fakeCtx(),
      aal: e,
      opts: { evaluateEthics: async () => ({ decision: 'flag', reason: 'soft-warn' }) },
    });
    expect(v.decision).toBe('allow');
    expect(v.tier).toBe('R2');
  });

  it('override header requires platform-owner', async () => {
    const e = makeEvaluator();
    await expect(composeChecks({
      role: 'tenant-admin' as RbacRole,
      principal: fakePrincipal(),
      op: {
        aalKind: 'tenant.delete',
        capability: 'memory:write' as any,
        scope: {},
      },
      ctx: fakeCtx({ override: { reason: 'sev1 incident' } }),
      aal: e,
    })).rejects.toThrow(AalOverrideDenied);
  });

  it('override allows platform-owner past R5', async () => {
    const e = makeEvaluator();
    const v = await composeChecks({
      role: 'platform-owner' as RbacRole,
      principal: fakePrincipal({ userId: 'mario' }),
      op: {
        aalKind: 'tenant.delete',
        capability: 'platform:tenants:delete' as any,
        scope: {},
      },
      ctx: fakeCtx({
        principal: fakePrincipal({ userId: 'mario' }),
        override: { reason: 'sev1 incident' },
      }),
      aal: e,
    });
    expect(v.decision).toBe('allow');
    expect(v.tier).toBe('R5');
    expect(v.reason).toMatch(/override: sev1 incident/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Audit hook
 * ────────────────────────────────────────────────────────────────── */

describe('AAL audit hook', () => {
  it('fires onVerdict for every evaluate() call', async () => {
    const events: Array<{ kind: string; reason: string }> = [];
    const audit: AalAuditHook = {
      onVerdict: ({ op, verdict }) => events.push({ kind: op.kind, reason: verdict.reason }),
      onOverride: () => {},
    };
    const e = makeEvaluator({ audit });
    await e.evaluate({ kind: 'memory.recall', scope: {} }, fakeCtx());
    await e.evaluate({ kind: 'memory.delete', scope: { affectedRows: 5 } }, fakeCtx());
    expect(events.length).toBe(2);
    expect(events[0]!.kind).toBe('memory.recall');
    expect(events[1]!.kind).toBe('memory.delete');
  });

  it('fires onOverride + onVerdict when override path is taken', async () => {
    const overrides: string[] = [];
    const verdicts: string[] = [];
    const audit: AalAuditHook = {
      onOverride: ({ reason }) => overrides.push(reason),
      onVerdict: ({ verdict }) => verdicts.push(verdict.decision),
    };
    const e = makeEvaluator({ audit });
    await e.evaluate(
      { kind: 'tenant.delete', scope: {} },
      fakeCtx({ override: { reason: 'fire drill' } }),
    );
    expect(overrides).toEqual(['fire drill']);
    expect(verdicts).toEqual(['allow']);
  });

  it('makeAalAuditHook writes through the supplied audit writer', async () => {
    const writes: any[] = [];
    const hook = makeAalAuditHook(async (ev) => writes.push(ev));
    hook.onVerdict({
      op: { kind: 'memory.delete', scope: { affectedRows: 1 } },
      ctx: fakeCtx(),
      verdict: { decision: 'allow_with_confirm', tier: 'R3', reason: 'r', confirmToken: 't', ttlSeconds: 300 },
    });
    // give the unawaited promise time to land
    await new Promise((r) => setImmediate(r));
    expect(writes.length).toBe(1);
    expect(writes[0].event_kind).toBe('aal.r3');
    expect(writes[0].details.confirm_ttl_seconds).toBe(300);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Schema artifact
 * ────────────────────────────────────────────────────────────────── */

describe('AAL_PENDING_SCHEMA_SQL', () => {
  it('contains the aal_pending_operations table and CHECK constraints', () => {
    expect(AAL_PENDING_SCHEMA_SQL).toMatch(/CREATE TABLE IF NOT EXISTS aal_pending_operations/);
    expect(AAL_PENDING_SCHEMA_SQL).toMatch(/CHECK \(tier IN \('R1','R2','R3','R4','R5'\)\)/);
    expect(AAL_PENDING_SCHEMA_SQL).toMatch(/CHECK \(status IN \('pending','approved','rejected','expired'\)\)/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Error classes export
 * ────────────────────────────────────────────────────────────────── */

describe('AAL error classes', () => {
  it('AalDenied carries tier + op kind + reason', () => {
    const err = new AalDenied('R5', 'tenant.delete', 'forbidden');
    expect(err.tier).toBe('R5');
    expect(err.opKind).toBe('tenant.delete');
    expect(err.explainReason).toBe('forbidden');
    expect(err.message).toMatch(/AAL denied R5 operation 'tenant.delete'/);
  });

  it('AalInvalidConfirmToken serializes reason', () => {
    const err = new AalInvalidConfirmToken('expired');
    expect(err.message).toMatch(/AAL confirm token invalid: expired/);
  });

  it('AalOverrideDenied serializes role', () => {
    const err = new AalOverrideDenied('tenant-admin');
    expect(err.message).toMatch(/AAL override requires platform-owner; principal is tenant-admin/);
  });

  it('NOOP_AUDIT_HOOK is callable with both methods', () => {
    expect(() => NOOP_AUDIT_HOOK.onVerdict({} as any)).not.toThrow();
    expect(() => NOOP_AUDIT_HOOK.onOverride({} as any)).not.toThrow();
  });
});
