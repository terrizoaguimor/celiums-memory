// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * RuntimeContext — the single object the dispatcher constructs once at
 * startup and threads through every handler that opts in.
 *
 * This is the integration glue for the Track 1 layers built across
 * ADRs 003 / 005 / 007 / 008 / 009 / 010 / 011 / 012 / 015 / 021 /
 * 022 / 023 / 024 / 025. Each layer ships independently testable —
 * RuntimeContext wires them together at runtime.
 *
 * The legacy McpToolContext fields (userId, capabilities, etc.) remain;
 * new handlers that want the security stack consume `ctx.runtime` instead
 * of building it themselves. Old handlers ignore `runtime` and keep
 * working — additive, not breaking.
 *
 * Construction is deliberately explicit. The factory `makeRuntimeContext`
 * takes the dependencies (StorageAdapter, audit writer, optional SyncEngine
 * passphrase) and returns the wired graph. Tests pass an InMemoryAdapter +
 * PlaintextSyncEngine to exercise the full path without a database.
 */

import type { StorageAdapter } from '../storage/index.js';
import type { SyncEngine } from '../sync/index.js';
import { PlaintextSyncEngine, ZkSyncEngine } from '../sync/index.js';
import type {
  AalEvaluator, AalAuditHook, AalRequestContext,
} from '../aal/index.js';
import {
  DefaultAalEvaluator, DefaultPolicyProvider,
  MemoryApprovalQueue, MemoryTokenStore, makeConfirmTokenManager,
  makeAalAuditHook, NOOP_AUDIT_HOOK,
} from '../aal/index.js';
import type { WriteAuditEvent } from '../aal/audit.js';

/** The composite runtime — what every "secure" handler reads from. */
export interface RuntimeContext {
  /** Persistent storage substrate (ADR-023). */
  storage: StorageAdapter;
  /** Sync mode engine (ADR-022) — plaintext or ZK envelope. */
  sync: SyncEngine;
  /** Three-orthogonal-checks gate (ADR-024). */
  aal: AalEvaluator;
  /** Optional ethics evaluator (ADR-021). Handlers passing user-authored
   *  content invoke this; pure lookup handlers omit. */
  evaluateEthics?: (input: { content: string; ctx: AalRequestContext }) => Promise<{ decision: 'allow' | 'flag' | 'block'; reason?: string }>;
  /** Append-only security event sink. Defaults to a writer that targets
   *  storage.auditWrite so the audit log lives in the same backend as
   *  memories + journal entries. Operators can swap in a dedicated
   *  writer that hits Loki / OTLP / etc. */
  writeAuditEvent: WriteAuditEvent;
}

export interface MakeRuntimeContextOpts {
  storage: StorageAdapter;
  /** When the runtime is configured for ZK mode, pass the passphrase
   *  the user typed at unlock. If absent, runtime defaults to plaintext
   *  (local-only or cloud-managed mode). */
  zkPassphrase?: string;
  /** Override the default writeAuditEvent — useful when the audit log
   *  must hit a different sink than the storage adapter. */
  writeAuditEvent?: WriteAuditEvent;
  /** Override the default evaluator. Tests sometimes substitute a
   *  fake that records calls. */
  aal?: AalEvaluator;
  /** Operator-supplied ethics evaluator. */
  evaluateEthics?: RuntimeContext['evaluateEthics'];
  /** AAL audit hook. Defaults to NOOP when no writer is configured. */
  aalAudit?: AalAuditHook;
  /** Sync engine override — when set, takes precedence over zkPassphrase + syncMode. */
  syncEngine?: SyncEngine;
  /** Sync mode to use when no syncEngine is provided. Defaults to
   *  'local-only' when zkPassphrase is absent; 'cloud-synced' when
   *  zkPassphrase is present. Pass explicitly to select 'cloud-managed'. */
  syncMode?: 'local-only' | 'cloud-managed';
  /** Default scope token-store secret for confirm tokens (ADR-024).
   *  Defaults to a process-local random secret; production deployments
   *  MUST supply a persistent secret so confirm tokens survive restarts. */
  confirmTokenSecret?: string;
}

export function makeRuntimeContext(opts: MakeRuntimeContextOpts): RuntimeContext {
  const writeAuditEvent =
    opts.writeAuditEvent ??
    (async (ev) => {
      // Default: write through the adapter's audit substrate. Failures
      // are recorded in stderr by the adapter; the writer returns false.
      await opts.storage.auditWrite({
        event_kind: ev.event_kind,
        user_id: ev.user_id,
        ...(ev.agent_id ? { agent_id: ev.agent_id } : {}),
        decision: ev.decision,
        reason: ev.reason,
        details: ev.details ?? {},
      });
    });

  const aal =
    opts.aal ??
    new DefaultAalEvaluator({
      policies: new DefaultPolicyProvider(),
      confirmTokens: makeConfirmTokenManager({
        secret: opts.confirmTokenSecret ?? randomSecret(),
        store: new MemoryTokenStore(),
      }),
      approvalQueue: new MemoryApprovalQueue(),
      audit: opts.aalAudit ?? (opts.writeAuditEvent ? makeAalAuditHook(opts.writeAuditEvent) : NOOP_AUDIT_HOOK),
    });

  const sync: SyncEngine =
    opts.syncEngine ??
    (opts.zkPassphrase
      ? new ZkSyncEngine({ passphrase: opts.zkPassphrase })
      : new PlaintextSyncEngine(opts.syncMode ?? 'local-only'));

  return {
    storage: opts.storage,
    sync,
    aal,
    writeAuditEvent,
    ...(opts.evaluateEthics ? { evaluateEthics: opts.evaluateEthics } : {}),
  };
}

function randomSecret(): string {
  // 32 hex chars = 128 bits of entropy. Adequate for a per-process secret
  // when operators forget to supply one; production must always supply
  // their own via confirmTokenSecret.
  const arr = new Uint8Array(16);
  for (let i = 0; i < 16; i++) arr[i] = (Math.random() * 256) | 0;
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
