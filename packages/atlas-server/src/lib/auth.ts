// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Auth helper — classifies the inbound `Authorization: Bearer ...` and
 * decides which key atlas-server uses when calling the inference backend.
 *
 * OSS model (#174 B2): there are no paid tiers. The tier-classifier
 * resolution + quota gating was the SaaS billing strategy and was
 * removed. What remains is identity + key routing:
 *
 *   1. `ck_(live|test)_*` — Celiums user api_key. Treated as caller
 *      identity; inference calls use the server-side fleet key. No tier,
 *      no quota — usage is still recorded for observability.
 *
 *   2. `doo_v1_*` / `sk-do-*` — inference fleet key brought by a
 *      service-to-service caller. The bearer IS the fleet key and is
 *      passed through as-is. "BYO fleet key" path.
 *
 *   3. `cmk_*` — Celiums Memory user key (e.g. forwarded by an MCP
 *      bridge). Caller identity for audit; inference calls use the
 *      server-side fleet key.
 *
 * Any other bearer format is rejected — atlas-server must never forward
 * an unrecognized bearer to the backend as if it were a fleet key.
 */

import type { Context } from 'hono';

export type AuthMode = 'user' | 'fleet' | 'cmk' | 'none';

export interface AuthContext {
  mode: AuthMode;
  /** Raw bearer (whatever was in Authorization). */
  apiKey: string | null;
  /** The key atlas-server uses to call the inference backend. */
  fleetKey: string | null;
  /** When auth fails, this is the HTTP status to return. */
  reject?: { status: 401 | 402 | 403 | 500 | 503; message: string };
}

const USER_KEY_RE  = /^ck_(live|test)_/;
const FLEET_KEY_RE = /^(doo_v1_|sk-do-)/;
const CMK_KEY_RE   = /^cmk_/;

export async function authenticate(c: Context): Promise<AuthContext> {
  const authHeader = c.req.header('authorization');
  const fleetKeyEnv = process.env.CELIUMS_FLEET_KEY ?? null;

  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return {
      mode: 'none',
      apiKey: null,
      fleetKey: fleetKeyEnv,
      reject: { status: 401, message: 'missing Authorization Bearer' },
    };
  }
  const bearer = authHeader.slice(7).trim();

  // 2. BYO fleet key — caller brings their own backend key; pass through.
  if (FLEET_KEY_RE.test(bearer)) {
    return {
      mode: 'fleet',
      apiKey: bearer,
      fleetKey: bearer,
    };
  }

  // 3. Celiums Memory key (cmk_*) — caller identity; route backend calls
  //    through the server's own configured fleet key.
  if (CMK_KEY_RE.test(bearer)) {
    if (!fleetKeyEnv) {
      return {
        mode: 'cmk',
        apiKey: bearer,
        fleetKey: null,
        reject: { status: 500, message: 'CELIUMS_FLEET_KEY not configured on atlas-server' },
      };
    }
    return {
      mode: 'cmk',
      apiKey: bearer,
      fleetKey: fleetKeyEnv,
    };
  }

  // 1. Celiums user api_key (ck_*) — caller identity; backend calls use
  //    the server fleet key. No tier, no quota (OSS: no paid tiers).
  //    `mode: 'user'` is kept so usage observability still records this.
  if (USER_KEY_RE.test(bearer)) {
    if (!fleetKeyEnv) {
      return {
        mode: 'user',
        apiKey: bearer,
        fleetKey: null,
        reject: { status: 500, message: 'CELIUMS_FLEET_KEY not configured on atlas-server' },
      };
    }
    return {
      mode: 'user',
      apiKey: bearer,
      fleetKey: fleetKeyEnv,
    };
  }

  // Anything else — unrecognized bearer; never forward to the backend.
  return {
    mode: 'none',
    apiKey: bearer,
    fleetKey: null,
    reject: { status: 401, message: 'unrecognized Authorization bearer format' },
  };
}
