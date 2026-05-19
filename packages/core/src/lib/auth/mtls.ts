// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * MtlsResolver — service-to-service identity from a client certificate.
 *
 * Expects an upstream ingress (nginx, Envoy, Traefik, Linkerd) to have
 * terminated TLS, validated the client certificate against the trusted
 * CA, and forwarded the subject information in one of:
 *
 *   - `X-Forwarded-Client-Cert` (Envoy / Istio canonical)
 *   - `X-SSL-Client-S-DN`       (nginx with `ssl_client_s_dn`)
 *   - `X-Client-Subject`        (Traefik option)
 *
 * The CN of the subject is parsed and encodes the principal id. We
 * accept three CN shapes:
 *
 *   1. `svc:<service-name>@<tenant-uuid>`     → service principal
 *   2. `agent:<agent-id>@<tenant-uuid>`       → agent principal
 *   3. `<user-id>@<tenant-uuid>`              → user principal
 *
 * Any cert reaching this handler is trusted — the ingress did the
 * heavy lifting. The engine NEVER trusts the header from a request that
 * came directly to a non-ingress port. ADR-006 mandates that direct
 * access bypasses ingress and reaches the engine only on `127.0.0.1`,
 * in which case mTLS makes no sense and this resolver yields.
 */

import type {
  CredentialResolver, CredentialInput, Principal,
} from './types.js';
import { AuthError } from './types.js';

const CN_RE = /CN=([^,\/]+)/i;
const URL_DECODE = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));

function extractCN(rawHeader: string): string | null {
  // X-Forwarded-Client-Cert is comma-separated key=value pairs. Find
  // the Subject= block, then pull the CN= component out of its DN.
  // Example: By=...;Hash=...;Subject="CN=svc:worker@<uuid>,O=Celiums"
  const decoded = URL_DECODE(rawHeader);
  // Try the XFCC Subject= shape first.
  const sub = /Subject="([^"]+)"/i.exec(decoded);
  if (sub) {
    const m = CN_RE.exec(sub[1]!);
    if (m) return m[1]!.trim();
  }
  // Try a bare DN.
  const m = CN_RE.exec(decoded);
  if (m) return m[1]!.trim();
  return null;
}

interface ParsedCN {
  kind: 'user' | 'service' | 'agent';
  userId: string;
  tenantId: string | null;
}

function parseCN(cn: string): ParsedCN | null {
  const at = cn.lastIndexOf('@');
  const left = at >= 0 ? cn.slice(0, at).trim() : cn.trim();
  const right = at >= 0 ? cn.slice(at + 1).trim() : '';
  if (!left) return null;

  // Tenant binding is optional but typical for Tier 3.
  const tenantId = right || null;

  if (left.startsWith('svc:')) {
    return { kind: 'service', userId: 'svc:' + left.slice(4), tenantId };
  }
  if (left.startsWith('agent:')) {
    return { kind: 'agent', userId: 'agent:' + left.slice(6), tenantId };
  }
  return { kind: 'user', userId: left, tenantId };
}

export class MtlsResolver implements CredentialResolver {
  readonly id = 'mtls' as const;

  async resolve(input: CredentialInput): Promise<Principal | null> {
    const cert = input.clientCert?.trim();
    if (!cert) return null;

    const cn = extractCN(cert);
    if (!cn) {
      throw new AuthError('mtls header present but no CN extractable', 'mtls');
    }
    const parsed = parseCN(cn);
    if (!parsed) {
      throw new AuthError(`mtls CN unparseable: ${cn}`, 'mtls');
    }

    return {
      type: parsed.kind,
      userId: parsed.userId,
      tenantId: parsed.tenantId,
      scopes: [],
      authMethod: 'mtls',
      credentialId: cn,
    };
  }
}
