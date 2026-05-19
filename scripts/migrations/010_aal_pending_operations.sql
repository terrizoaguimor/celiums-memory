-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Celiums Solutions LLC
--
-- ADR-024 — Action Authority Layer
-- Stores multi-party approval queue entries for R4 and R5 operations.
-- See packages/core/src/lib/aal/approval-queue.ts for the runtime that
-- reads/writes this table; the schema constant in that file is the
-- single source of truth and this migration mirrors it for ops who
-- prefer applying SQL through migration tooling.

CREATE TABLE IF NOT EXISTS aal_pending_operations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  requester_user_id   text NOT NULL,
  requester_tenant_id text,
  op_kind             text NOT NULL,
  op_scope            jsonb NOT NULL DEFAULT '{}'::jsonb,
  op_summary          text,
  tier                text NOT NULL CHECK (tier IN ('R1','R2','R3','R4','R5')),
  approvers_required  int  NOT NULL CHECK (approvers_required >= 1),
  approved_by         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','expired')),
  decision_at         timestamptz,
  decision_reason     text
);

CREATE INDEX IF NOT EXISTS idx_aal_pending_requester
  ON aal_pending_operations(requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_pending_status
  ON aal_pending_operations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_aal_pending_tenant
  ON aal_pending_operations(requester_tenant_id, created_at DESC)
  WHERE requester_tenant_id IS NOT NULL;
