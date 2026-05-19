// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Capability gates — the throwing variant of `hasCapability`.
 *
 * Every handler protected by RBAC calls `requireCapability(role,
 * capability, subject)`. The function throws `RbacDenied` on failure;
 * the HTTP layer maps that to 403.
 *
 * Platform-level capabilities (`platform:*`) auto-audit on every USE
 * via the `auditPlatformCapability` callback. The hook is optional —
 * pass it from the wired-up dispatcher.
 */

import type { Capability, CanonicalRole } from './types.js';
import { isPlatformCapability, RbacDenied } from './types.js';
import { hasCapability } from './capabilities.js';
import type { Principal } from '../auth/types.js';

export interface CapabilityCheckOptions {
  /** Called on every USE of a platform:* capability that was granted.
   *  Fire-and-forget; failures should not propagate. */
  auditPlatformCapability?: (event: PlatformCapabilityAuditEvent) => void;
  /** Caller-supplied subject string for the audit + error context.
   *  Examples: 'tenant:abc', 'memory:m_xyz', 'cross_tenant:list'. */
  subject?: string;
}

export interface PlatformCapabilityAuditEvent {
  userId: string;
  agentId?: string;
  tenantId: string | null;
  role: CanonicalRole;
  capability: Capability;
  subject: string;
  /** Whether the gate ultimately allowed the request. */
  granted: boolean;
}

/** Throws RbacDenied on failure; returns silently on success. */
export function requireCapability(
  role: CanonicalRole,
  capability: Capability,
  principal: Principal,
  opts: CapabilityCheckOptions = {},
): void {
  const subject = opts.subject ?? capability;
  const granted = hasCapability(role, capability);

  if (isPlatformCapability(capability)) {
    opts.auditPlatformCapability?.({
      userId: principal.userId,
      ...(principal.attributes?.['agentId'] !== undefined ? { agentId: String(principal.attributes['agentId']) } : {}),
      tenantId: principal.tenantId,
      role,
      capability,
      subject,
      granted,
    });
  }

  if (!granted) {
    throw new RbacDenied(role, capability, subject);
  }
}

/** Boolean variant — useful when the handler wants to branch instead
 *  of throwing. Still audits platform:* uses. */
export function checkCapability(
  role: CanonicalRole,
  capability: Capability,
  principal: Principal,
  opts: CapabilityCheckOptions = {},
): boolean {
  const subject = opts.subject ?? capability;
  const granted = hasCapability(role, capability);
  if (isPlatformCapability(capability)) {
    opts.auditPlatformCapability?.({
      userId: principal.userId,
      ...(principal.attributes?.['agentId'] !== undefined ? { agentId: String(principal.attributes['agentId']) } : {}),
      tenantId: principal.tenantId,
      role,
      capability,
      subject,
      granted,
    });
  }
  return granted;
}

/** Wire a check audit hook to the global security_audit_log. */
export function makeSecurityAuditHook(
  writeAuditEvent: (ev: {
    event_kind: string;
    user_id: string;
    agent_id?: string;
    decision: 'allow' | 'deny';
    reason: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>,
): (event: PlatformCapabilityAuditEvent) => void {
  return (event) => {
    // Fire-and-forget; we never block the call path on audit IO.
    void writeAuditEvent({
      event_kind: 'rbac.platform_capability',
      user_id: event.userId,
      ...(event.agentId ? { agent_id: event.agentId } : {}),
      decision: event.granted ? 'allow' : 'deny',
      reason: `${event.role} → ${event.capability}`,
      details: {
        tenant_id: event.tenantId,
        role: event.role,
        capability: event.capability,
        subject: event.subject,
      },
    }).catch(() => { /* swallow — audit must not block */ });
  };
}
