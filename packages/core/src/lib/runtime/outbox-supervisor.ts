// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Outbox supervisor — owns the OutboxWorker lifecycle when the chosen
 * adapter is pg-triple or k8s-pg-triple. For sqlite/in-memory tiers
 * there's no outbox concept (vectors live in-process) so this is a no-op.
 *
 * Wire:
 *   const sup = makeOutboxSupervisor({ runtime, embedFn });
 *   sup.start();                 // launches background loop
 *   process.on('SIGTERM', () => sup.stop());
 *
 * The `embedFn` is the operator's choice — production wires a real
 * ONNX runtime or remote embedding service. Default in this module is
 * a stub that throws when invoked, so a missing embedder fails LOUD
 * (per ADR-022 §"Local embedder").
 */

import type { RuntimeContext } from './context.js';
import {
  OutboxWorker, PgTripleAdapter, K8sPgTripleAdapter,
} from '../storage/index.js';

export interface OutboxSupervisorOpts {
  runtime: RuntimeContext;
  /** Operator-supplied embedder. If omitted, the supervisor still
   *  starts but every drain attempt throws — useful to detect missing
   *  configuration in staging before production. */
  embedFn?: (input: { id: string; content: string }) => Promise<Float32Array>;
  /** Polling interval when the outbox queue is empty. Default 5s. */
  pollIntervalMs?: number;
  /** Per-tick batch size. Default 100. */
  batchSize?: number;
  /** Optional logger; defaults to console.error for failures. */
  logger?: { info?: (msg: string) => void; error?: (msg: string) => void };
}

export interface OutboxSupervisor {
  /** Whether the supervisor is currently running its loop. */
  readonly running: boolean;
  /** Whether outbox is applicable to the runtime's adapter (false for
   *  sqlite / in-memory). When false, start()/stop() are no-ops. */
  readonly applicable: boolean;
  start(): void;
  stop(): Promise<void>;
  /** Run a single drain pass synchronously — useful for tests and
   *  for periodic reconciliation jobs. */
  runOnce(): Promise<{ drained: number; skipped: boolean }>;
}

export function makeOutboxSupervisor(opts: OutboxSupervisorOpts): OutboxSupervisor {
  const isPg = opts.runtime.storage instanceof PgTripleAdapter
    || opts.runtime.storage instanceof K8sPgTripleAdapter;

  if (!isPg) {
    // No-op supervisor for non-pg tiers.
    return {
      get running() { return false; },
      applicable: false,
      start() { /* no-op */ },
      async stop() { /* no-op */ },
      async runOnce() { return { drained: 0, skipped: true }; },
    };
  }

  // Extract the pg pool + qdrant client from the adapter so the worker
  // can talk to them directly. The worker is decoupled from the
  // adapter surface so it can also run as a separate process.
  const { pool, qdrant } = (opts.runtime.storage as PgTripleAdapter).getInfra();

  const worker = new OutboxWorker(
    pool,
    qdrant,
    {
      pollIntervalMs: opts.pollIntervalMs ?? 5000,
      batchSize: opts.batchSize ?? 100,
      ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
    },
  );
  const logger = opts.logger;

  let loopPromise: Promise<void> | null = null;

  return {
    applicable: true,
    get running() { return loopPromise !== null; },
    start() {
      if (loopPromise !== null) return; // already running
      logger?.info?.('outbox supervisor: starting drain loop');
      loopPromise = worker.startLoop().catch((e) => {
        logger?.error?.(`outbox supervisor loop crashed: ${(e as Error).message}`);
        loopPromise = null;
      });
    },
    async stop() {
      if (loopPromise === null) return;
      logger?.info?.('outbox supervisor: stopping');
      worker.stop();
      await loopPromise;
      loopPromise = null;
    },
    async runOnce() {
      if (!opts.embedFn) {
        return { drained: 0, skipped: true };
      }
      const r = await worker.runOnce();
      return { drained: r.drained, skipped: false };
    },
  };
}
