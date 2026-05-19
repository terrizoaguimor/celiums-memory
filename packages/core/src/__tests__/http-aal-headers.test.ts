// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Tests — HTTP AAL header middleware.
 */

import { describe, it, expect } from 'vitest';
import {
  extractAalHeaders, applyAalHeadersToCtx, getAalHeader,
  AAL_HEADER_CONFIRM, AAL_HEADER_OVERRIDE, AAL_HEADER_PENDING_ID,
} from '../index.js';

describe('getAalHeader', () => {
  it('reads from a Web Headers instance (case-insensitive)', () => {
    const h = new Headers();
    h.set('X-Celiums-AAL-Confirm', 'cmk_conf_abc');
    expect(getAalHeader(h, AAL_HEADER_CONFIRM)).toBe('cmk_conf_abc');
    expect(getAalHeader(h, 'X-CELIUMS-AAL-CONFIRM')).toBe('cmk_conf_abc');
  });

  it('reads from a plain Record<string,string> (case-insensitive)', () => {
    const h = { 'X-Celiums-AAL-Override': 'sev1 incident' };
    expect(getAalHeader(h, AAL_HEADER_OVERRIDE)).toBe('sev1 incident');
  });

  it('reads from a Record with string[] values (Node http style)', () => {
    const h = { 'x-celiums-aal-pending-id': ['op_123', 'op_456'] };
    expect(getAalHeader(h, AAL_HEADER_PENDING_ID)).toBe('op_123');
  });

  it('reads from a Map (custom adapters)', () => {
    const h = new Map([['x-celiums-aal-confirm', 'cmk_conf_xyz']]);
    expect(getAalHeader(h, AAL_HEADER_CONFIRM)).toBe('cmk_conf_xyz');
  });

  it('returns undefined when header is absent', () => {
    const h = new Headers();
    expect(getAalHeader(h, AAL_HEADER_CONFIRM)).toBeUndefined();
  });
});

describe('extractAalHeaders', () => {
  it('extracts all three when present', () => {
    const h = {
      'X-Celiums-AAL-Confirm': 'tok',
      'X-Celiums-AAL-Override': 'reason',
      'X-Celiums-AAL-Pending-Id': 'op_42',
    };
    expect(extractAalHeaders(h)).toEqual({
      aalConfirmToken: 'tok',
      aalOverrideReason: 'reason',
      aalApprovedPendingId: 'op_42',
    });
  });

  it('omits absent headers (no undefined values written)', () => {
    const h = { 'X-Celiums-AAL-Confirm': 'tok' };
    const ext = extractAalHeaders(h);
    expect(ext).toEqual({ aalConfirmToken: 'tok' });
    expect('aalOverrideReason' in ext).toBe(false);
    expect('aalApprovedPendingId' in ext).toBe(false);
  });

  it('returns empty object when no AAL headers present', () => {
    expect(extractAalHeaders({})).toEqual({});
  });
});

describe('applyAalHeadersToCtx', () => {
  it('produces a new ctx with header fields applied (does not mutate)', () => {
    const ctx = {
      userId: 'alice',
      capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
    };
    const h = {
      'X-Celiums-AAL-Confirm': 'tok',
      'X-Celiums-AAL-Pending-Id': 'op_42',
    };
    const out = applyAalHeadersToCtx(h, ctx);
    expect(out).not.toBe(ctx);
    expect(out.aalConfirmToken).toBe('tok');
    expect(out.aalApprovedPendingId).toBe('op_42');
    // Original ctx remains unchanged
    expect((ctx as any).aalConfirmToken).toBeUndefined();
  });

  it('preserves untouched ctx fields', () => {
    const ctx = {
      userId: 'alice',
      capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      agentId: 'celiums',
    };
    const out = applyAalHeadersToCtx({}, ctx);
    expect(out.userId).toBe('alice');
    expect(out.agentId).toBe('celiums');
  });
});
