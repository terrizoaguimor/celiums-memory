// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SAML 2.0 Service Provider stub — ADR-015 §"SAML 2.0 integration".
 *
 * v1 scope of this file:
 *   - Interface that matches the OIDC login flow shape.
 *   - Lazy-import @node-saml/node-saml so the OSS engine doesn't pull
 *     the SAML dep tree when only OIDC is used.
 *   - Validates config + builds an AuthnRequest URL (HTTP-Redirect
 *     binding).
 *   - Returns a typed error when the actual library isn't installed
 *     so downstream callers can surface "SAML is unavailable" cleanly.
 *
 * v2 scope (NOT in this file yet):
 *   - Full AuthnResponse signature verification.
 *   - Encrypted assertions.
 *   - SLO (Single Logout) flow.
 *
 * The contract is stable: when @node-saml/node-saml is installed, the
 * caller-facing API works. When it's not, the same calls throw a
 * clear `SsoConfigError` so the operator knows to install the dep.
 */

import type {
  SamlIdpConfig, SsoSession, IdpProtocol,
} from './types.js';
import { SsoConfigError, SsoCallbackError } from './types.js';

export interface CreateSamlAuthRequestOptions {
  cfg: SamlIdpConfig;
  /** Caller-supplied relay state — echoed back on ACS. */
  relayState?: string;
}

export interface SamlAuthRequest {
  redirectTo: string;
  /** RelayState that the caller persists. */
  relayState: string;
}

async function importNodeSaml(): Promise<any> {
  // @ts-ignore — optional peer dep
  const mod = await import('@node-saml/node-saml').catch((): null => null);
  if (!mod) {
    throw new SsoConfigError(
      'SAML login requires @node-saml/node-saml. Install with: ' +
      'npm i @node-saml/node-saml',
    );
  }
  return mod;
}

function validateSamlCfg(cfg: SamlIdpConfig): void {
  if (!cfg.entityId)        throw new SsoConfigError('SAML cfg.entityId required');
  if (!cfg.ssoUrl)          throw new SsoConfigError('SAML cfg.ssoUrl required');
  if (!cfg.acsUrl)          throw new SsoConfigError('SAML cfg.acsUrl required');
  if (!cfg.spEntityId)      throw new SsoConfigError('SAML cfg.spEntityId required');
  if (!cfg.signingCertPem)  throw new SsoConfigError('SAML cfg.signingCertPem required');
}

export async function createSamlAuthRequest(
  opts: CreateSamlAuthRequestOptions,
): Promise<SamlAuthRequest> {
  validateSamlCfg(opts.cfg);
  const mod = await importNodeSaml();
  const { SAML } = mod;
  if (!SAML) throw new SsoConfigError('@node-saml/node-saml shape changed — SAML export missing');

  const saml = new SAML({
    callbackUrl: opts.cfg.acsUrl,
    entryPoint: opts.cfg.ssoUrl,
    issuer: opts.cfg.spEntityId,
    idpIssuer: opts.cfg.entityId,
    cert: opts.cfg.signingCertPem,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: opts.cfg.assertionSigned ?? true,
    signatureAlgorithm: 'sha256',
  });

  const relayState = opts.relayState ?? '';
  let url: string;
  try {
    url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
  } catch (e) {
    throw new SsoConfigError(`SAML AuthnRequest build failed: ${(e as Error).message}`);
  }
  return { redirectTo: url, relayState };
}

export interface HandleSamlCallbackOptions {
  /** Raw SAMLResponse POST body (URL-decoded). */
  samlResponse: string;
  /** RelayState we asked the IdP to echo. */
  returnedRelayState?: string;
  persistedRelayState?: string;
  cfg: SamlIdpConfig;
}

export async function handleSamlCallback(opts: HandleSamlCallbackOptions): Promise<SsoSession> {
  validateSamlCfg(opts.cfg);
  if (opts.persistedRelayState !== undefined && opts.returnedRelayState !== opts.persistedRelayState) {
    throw new SsoCallbackError('SAML RelayState mismatch');
  }
  const mod = await importNodeSaml();
  const { SAML } = mod;
  const saml = new SAML({
    callbackUrl: opts.cfg.acsUrl,
    entryPoint: opts.cfg.ssoUrl,
    issuer: opts.cfg.spEntityId,
    idpIssuer: opts.cfg.entityId,
    cert: opts.cfg.signingCertPem,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned: opts.cfg.assertionSigned ?? true,
    signatureAlgorithm: 'sha256',
  });

  let profile: any;
  try {
    const { profile: p } = await saml.validatePostResponseAsync({ SAMLResponse: opts.samlResponse });
    profile = p;
  } catch (e) {
    throw new SsoCallbackError(`SAML response validation failed: ${(e as Error).message}`);
  }
  if (!profile) throw new SsoCallbackError('SAML response had no profile');

  const attrMap = opts.cfg.attributeMap ?? {};
  const subAttr = attrMap.sub ?? 'nameID';
  const emailAttr = attrMap.email ?? 'email';
  const groupsAttr = attrMap.groups ?? 'groups';
  const tenantAttr = attrMap.tenantId ?? 'tenant_id';

  const subject = profile[subAttr] ?? profile.nameID;
  if (!subject) throw new SsoCallbackError('SAML profile missing subject');

  const externalGroups = (() => {
    const v = profile[groupsAttr];
    if (Array.isArray(v)) return v.filter((g: any): g is string => typeof g === 'string');
    if (typeof v === 'string') return v.split(/[ ,;]+/).filter(Boolean);
    return [];
  })();

  const issuerHost = (() => {
    try { return new URL(opts.cfg.entityId).host; } catch { return opts.cfg.entityId; }
  })();
  const userId = `saml:${issuerHost}:${subject}`;
  const tenantId = typeof profile[tenantAttr] === 'string' ? (profile[tenantAttr] as string) : null;

  const issuedAt = new Date();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

  const session: SsoSession = {
    userId,
    tenantId,
    externalGroups,
    role: 'user',
    idp: { id: `saml:${issuerHost}`, protocol: 'saml' as IdpProtocol, entity: opts.cfg.entityId },
    issuedAt,
    expiresAt,
  };
  if (profile[emailAttr]) session.email = profile[emailAttr];
  if (profile.displayName ?? profile.cn) session.displayName = profile.displayName ?? profile.cn;
  return session;
}
