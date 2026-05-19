// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Tests — OutboxSupervisor.
 */

import { describe, it, expect } from 'vitest';
import {
  makeOutboxSupervisor, makeRuntimeContext, InMemoryAdapter,
} from '../index.js';

describe('OutboxSupervisor', () => {
  it('reports applicable=false for in-memory adapter (no-op)', () => {
    const runtime = makeRuntimeContext({
      storage: new InMemoryAdapter(),
    });
    const sup = makeOutboxSupervisor({ runtime });
    expect(sup.applicable).toBe(false);
    expect(sup.running).toBe(false);
    sup.start(); // no-op
    expect(sup.running).toBe(false);
  });

  it('no-op runOnce returns skipped=true for non-pg adapter', async () => {
    const runtime = makeRuntimeContext({ storage: new InMemoryAdapter() });
    const sup = makeOutboxSupervisor({ runtime });
    const r = await sup.runOnce();
    expect(r).toEqual({ drained: 0, skipped: true });
  });

  it('stop() is safe to call when not started', async () => {
    const runtime = makeRuntimeContext({ storage: new InMemoryAdapter() });
    const sup = makeOutboxSupervisor({ runtime });
    await expect(sup.stop()).resolves.toBeUndefined();
  });
});
