// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * AAL — Action Authority Layer
 *
 * Implements ADR-024. See lib/aal/types.ts for the surface and
 * lib/aal/compose.ts for the canonical three-orthogonal-checks
 * composition point.
 */

export * from './types.js';
export {
  DEFAULT_POLICIES,
  UNKNOWN_DEFAULT_TIER,
  DefaultPolicyProvider,
  ComposedPolicyProvider,
  type Classifier,
} from './policy-defaults.js';
export {
  MemoryTokenStore,
  ValkeyTokenStore,
  makeConfirmTokenManager,
  hashScope,
  type TokenStore,
  type ConfirmTokenManager,
  type ConfirmTokenPayload,
} from './confirm-tokens.js';
export {
  MemoryApprovalQueue,
  PostgresApprovalQueue,
  AAL_PENDING_SCHEMA_SQL,
  type ApprovalQueue,
  type PendingOperation,
  type PendingStatus,
} from './approval-queue.js';
export {
  makeAalAuditHook,
  NOOP_AUDIT_HOOK,
  type AalAuditHook,
  type WriteAuditEvent,
} from './audit.js';
export { DefaultAalEvaluator, type DefaultAalEvaluatorOpts } from './evaluator.js';
export { composeChecks, EthicsBlocked, type ComposedOperation, type ComposeChecksOpts } from './compose.js';
export {
  makeApprovalApi,
  type ApprovalApi,
  type ApprovalApiOpts,
  type ApiResult,
  type ListPendingOpts,
} from './approval-api.js';
