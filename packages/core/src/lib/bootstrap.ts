// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bootstrap data aggregator — backs `GET /v1/bootstrap` per
 * CELIUMS-API-CONTRACT.md §3.1.
 *
 * Goal: return everything the Console needs to render after a
 * cold load (user, tenant, principal, permissions, features,
 * sync mode, ethics profile, atlas state, providers, server)
 * in a SINGLE round-trip instead of 5+ separate calls.
 *
 * Pure read; no mutations. Aggregation happens in-process from
 * already-loaded state where possible to keep the call fast.
 */

export type DeployMode = 'single-user' | 'vps' | 'enterprise';
export type SyncMode = 'local-only' | 'zero-knowledge' | 'managed';
export type Role = 'owner' | 'admin' | 'member' | 'guest';
export type AALLevelStr = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type AtlasTierStr = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface BootstrapResponse {
  user: {
    id: string;
    name: string;
    email: string;
    avatar_url: string | null;
    timezone: string;
    locale: 'es' | 'en';
    created_at: string;
  };
  tenant: {
    id: string;
    name: string;
    members_count: number;
    memories_count: number;
  };
  principal: {
    role: Role;
    agent_id: string | null;
  };
  permissions: Record<string, AALLevelStr>;
  features: Record<string, boolean>;
  sync_mode: SyncMode;
  ethics_profile: {
    id: string;
    version: string;
    active: boolean;
  };
  atlas: {
    tier_min: AtlasTierStr;
    tier_max: AtlasTierStr;
    force_tier: string | null;
    budget_mtd_usd: number;
    spent_mtd_usd: number;
  };
  providers: Array<{
    id: string;
    configured: boolean;
    managed?: boolean;
    endpoint?: string;
    models: number;
  }>;
  server: {
    version: string;
    build: string;
    deploy_mode: DeployMode;
  };
}

/**
 * Pick the deploy mode the Console should render for. Heuristic
 * based on env flags:
 *
 *   - `CELIUMS_DEPLOY_MODE` explicit override wins.
 *   - Else if running in Kubernetes → 'enterprise'.
 *   - Else if `VPS=true` or `DO_APP_PLATFORM` → 'vps'.
 *   - Default → 'single-user'.
 */
export function detectDeployMode(): DeployMode {
  const explicit = process.env['CELIUMS_DEPLOY_MODE'];
  if (explicit === 'single-user' || explicit === 'vps' || explicit === 'enterprise') {
    return explicit;
  }
  if (process.env['KUBERNETES_SERVICE_HOST']) return 'enterprise';
  if (process.env['VPS'] === 'true' || process.env['DO_APP_PLATFORM']) return 'vps';
  return 'single-user';
}

/**
 * Map deploy mode → feature flags. Single source of truth so the
 * Console can hide/show surfaces without hardcoding mode checks.
 */
export function featuresForDeployMode(mode: DeployMode): Record<string, boolean> {
  const base: Record<string, boolean> = {
    voice: false,
    image_gen: false,
    approval_queue: true,
    channels_visible: true,
  };
  switch (mode) {
    case 'single-user':
      return { ...base, tenant_management: false, billing: false, sso: false, audit_advanced: false };
    case 'vps':
      return { ...base, tenant_management: false, billing: false, sso: false, audit_advanced: true };
    case 'enterprise':
      return { ...base, tenant_management: true, billing: true, sso: true, audit_advanced: true };
  }
}

/**
 * Default permissions matrix per role. The Console reads this via
 * `/v1/bootstrap.permissions` to know which UI affordances to enable.
 * The admin can override per-cell via `/v1/admin/permissions`.
 */
const ROLE_PERMISSIONS: Record<Role, Record<string, AALLevelStr>> = {
  owner: { memory: 'R5', journal: 'R5', skills: 'R5', aal: 'R5', ethics: 'R5', members: 'R5', keys: 'R5', sync: 'R5', billing: 'R5', sso: 'R5' },
  admin: { memory: 'R4', journal: 'R4', skills: 'R4', aal: 'R4', ethics: 'R3', members: 'R4', keys: 'R3', sync: 'R3', billing: 'R0', sso: 'R3' },
  member: { memory: 'R2', journal: 'R2', skills: 'R2', aal: 'R1', ethics: 'R0', members: 'R0', keys: 'R1', sync: 'R1', billing: 'R0', sso: 'R0' },
  guest: { memory: 'R0', journal: 'R0', skills: 'R1', aal: 'R0', ethics: 'R0', members: 'R0', keys: 'R0', sync: 'R0', billing: 'R0', sso: 'R0' },
};

export function permissionsForRole(role: Role): Record<string, AALLevelStr> {
  return { ...ROLE_PERMISSIONS[role] };
}

/**
 * Principal context resolved upstream from the caller's API key.
 * Single-user mode synthesizes this from env; managed mode resolves
 * from celiums-accounts.
 */
export interface PrincipalInfo {
  userId: string;
  userName: string;
  userEmail: string;
  userCreatedAt: string;
  tenantId: string;
  tenantName: string;
  role: Role;
}

export interface BootstrapInput {
  principal: PrincipalInfo;
  serverVersion: string;
  serverBuild: string;
}

export interface BootstrapSources {
  memoriesCount: () => Promise<number>;
  membersCount: () => Promise<number>;
  atlasSpend: () => Promise<{ mtd_usd: number; budget_usd: number; force_tier: string | null }>;
  providersConfigured: () => Promise<BootstrapResponse['providers']>;
  ethicsProfile: () => Promise<BootstrapResponse['ethics_profile']>;
  syncMode: () => Promise<SyncMode>;
}

/**
 * Aggregate all bootstrap state in parallel. Sources that throw
 * fall back to sensible defaults so the Console never sees a 500
 * just because one optional source (e.g., billing) is unavailable.
 */
export async function buildBootstrap(
  input: BootstrapInput,
  sources: BootstrapSources,
): Promise<BootstrapResponse> {
  const deployMode = detectDeployMode();
  const p = input.principal;

  const atlasDefault: { mtd_usd: number; budget_usd: number; force_tier: string | null } = {
    mtd_usd: 0,
    budget_usd: 0,
    force_tier: null,
  };
  const providersDefault: BootstrapResponse['providers'] = [];
  const ethicsDefault: BootstrapResponse['ethics_profile'] = {
    id: 'balanced',
    version: '1.4.0',
    active: true,
  };
  const [memoriesCount, membersCount, atlas, providers, ethics, syncMode] = await Promise.all([
    sources.memoriesCount().catch(() => 0),
    sources.membersCount().catch(() => 1),
    sources.atlasSpend().catch(() => atlasDefault),
    sources.providersConfigured().catch(() => providersDefault),
    sources.ethicsProfile().catch(() => ethicsDefault),
    sources.syncMode().catch((): SyncMode => 'managed'),
  ]);

  return {
    user: {
      id: p.userId,
      name: p.userName,
      email: p.userEmail,
      avatar_url: null,
      timezone: process.env['CELIUMS_DEFAULT_TIMEZONE'] ?? 'UTC',
      locale: (process.env['CELIUMS_DEFAULT_LOCALE'] as 'es' | 'en') ?? 'es',
      created_at: p.userCreatedAt,
    },
    tenant: {
      id: p.tenantId,
      name: p.tenantName,
      members_count: membersCount,
      memories_count: memoriesCount,
    },
    principal: { role: p.role, agent_id: null },
    permissions: permissionsForRole(p.role),
    features: featuresForDeployMode(deployMode),
    sync_mode: syncMode,
    ethics_profile: ethics,
    atlas: {
      tier_min: 'T0',
      tier_max: 'T5',
      force_tier: atlas.force_tier,
      budget_mtd_usd: atlas.budget_usd,
      spent_mtd_usd: atlas.mtd_usd,
    },
    providers,
    server: {
      version: input.serverVersion,
      build: input.serverBuild,
      deploy_mode: deployMode,
    },
  };
}

/**
 * Synthesize a PrincipalInfo from an ApiKey when running in
 * single-user / VPS mode where there's no celiums-accounts to
 * query. `userId` from the key + env-configured display info.
 */
export function singleUserPrincipal(args: {
  userId: string;
  label: string;
  createdAt: Date;
  scope: 'admin' | 'user';
}): PrincipalInfo {
  return {
    userId: args.userId,
    userName: process.env['CELIUMS_USER_NAME'] ?? args.label,
    userEmail: process.env['CELIUMS_USER_EMAIL'] ?? '',
    userCreatedAt: args.createdAt.toISOString(),
    tenantId: process.env['CELIUMS_TENANT_ID'] ?? 'default',
    tenantName: process.env['CELIUMS_TENANT_NAME'] ?? 'default',
    role: args.scope === 'admin' ? 'owner' : 'member',
  };
}
