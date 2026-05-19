// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * K8sPgTripleAdapter — Enterprise tier.
 *
 * Same logical interface as PgTripleAdapter. The differences are
 * operational, not behavioural:
 *
 *   - Wraps a HA-aware pool that routes reads to read-replicas when
 *     available and writes to the primary.
 *   - Reports `replication=k8s-statefulset`.
 *   - Adds an optional `failoverDetect` hook that the runtime can poll
 *     to learn when the underlying primary failed over. The hook is
 *     supplied by the operator (k8s probes, DO Managed PG failover
 *     events, RDS event subscriptions, etc.).
 *
 * The class extends PgTripleAdapter rather than reimplementing it.
 */

import { PgTripleAdapter, type PgTripleAdapterOpts } from './pg-triple-adapter.js';
import type { AdapterCapabilities } from './types.js';

export interface K8sPgTripleAdapterOpts extends PgTripleAdapterOpts {
  /** Optional hook the operator wires to whatever signal indicates that
   *  the primary failed over. Polled by the adapter when stats() is called;
   *  the adapter logs to stderr and continues with the new primary. */
  failoverDetect?: () => Promise<{ failedOver: boolean; at?: string }>;
}

export class K8sPgTripleAdapter extends PgTripleAdapter {
  // Re-declared with `override` to satisfy strict checks against the
  // base's narrowed AdapterId literal. The interface contract uses the
  // union AdapterId so consumers get the wider type from StorageAdapter.
  override readonly id = 'k8s-pg-triple' as const;
  override readonly capabilities: AdapterCapabilities = {
    vectorSearch: 'delegated',
    atomicCrossStore: false,
    rowLevelSecurity: true,
    replication: 'k8s-statefulset',
  };

  private readonly failoverDetect?: () => Promise<{ failedOver: boolean; at?: string }>;

  constructor(opts: K8sPgTripleAdapterOpts) {
    super(opts);
    if (opts.failoverDetect) this.failoverDetect = opts.failoverDetect;
  }

  override async stats() {
    const base = await super.stats();
    if (this.failoverDetect) {
      try {
        const r = await this.failoverDetect();
        if (r.failedOver) {
          console.warn('[celiums-core] k8s-pg-triple: primary failover detected at', r.at);
        }
      } catch (e) {
        console.error('[celiums-core] failoverDetect threw:', (e as Error).message);
      }
    }
    return base;
  }
}
