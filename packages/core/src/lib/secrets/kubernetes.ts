// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * K8sSecretProvider — reads from the in-cluster Kubernetes Secrets API.
 *
 * The Helm chart (ADR-013) mounts the pod's service-account token, so
 * the in-cluster client gets RBAC-scoped access automatically. The
 * chart restricts the SA's role to `get` on a single Secrets namespace.
 *
 * Two storage models are supported:
 *
 *   1. ONE Secret with many keys (`data.NAME` → value). Looked up by
 *      `name` against `data[name]`. This is the convention when the
 *      Helm chart bundles config into a single Secret object.
 *
 *   2. ONE Secret per name (`name` matches the Secret's metadata.name,
 *      with one well-known key like `value`). Useful for ExternalSecrets
 *      controllers and SealedSecrets.
 *
 * The provider tries (1) first, falls back to (2). Cache TTL is 30s
 * to balance freshness with API server load — production rotation is
 * fast enough.
 *
 * Lazy-imports `@kubernetes/client-node` so the dep is opt-in.
 */

import type { SecretProvider } from './types.js';
import { SecretNotFound, SecretBackendUnavailable } from './types.js';

export interface K8sProviderOptions {
  /** K8s namespace. Defaults to env CELIUMS_K8S_NAMESPACE or 'memory'. */
  namespace?: string;
  /** Name of the bundle Secret (model 1). Defaults to 'celiums-memory-env'. */
  bundleSecretName?: string;
  /** Key inside per-name Secrets (model 2). Defaults to 'value'. */
  perSecretKey?: string;
  /** Cache TTL in ms. Defaults to 30s. */
  cacheTtlMs?: number;
}

interface CacheEntry { value: string; expiresAt: number }

export class K8sSecretProvider implements SecretProvider {
  readonly id = 'kubernetes' as const;
  readonly name: string;
  private readonly namespace: string;
  private readonly bundleSecretName: string;
  private readonly perSecretKey: string;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private apiPromise: Promise<unknown> | null = null;

  constructor(opts: K8sProviderOptions = {}) {
    this.namespace = opts.namespace ?? process.env['CELIUMS_K8S_NAMESPACE'] ?? 'memory';
    this.bundleSecretName = opts.bundleSecretName ?? 'celiums-memory-env';
    this.perSecretKey = opts.perSecretKey ?? 'value';
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.name = `Kubernetes (${this.namespace})`;
  }

  private async getApi(): Promise<any> {
    if (this.apiPromise) return this.apiPromise;
    this.apiPromise = (async (): Promise<any> => {
      // @kubernetes/client-node is an OPTIONAL peer dependency. Operators
      // running Tier 3 install it; Tier 1/2 don't. The dynamic import +
      // ts-ignore is the same pattern as our other optional adapters.
      // @ts-ignore — optional dep, may not be installed
      const mod = await import('@kubernetes/client-node').catch((): null => null);
      if (!mod) {
        throw new SecretBackendUnavailable(
          this.id, '@kubernetes/client-node not installed',
        );
      }
      const { KubeConfig, CoreV1Api } = mod as any;
      const cfg = new KubeConfig();
      try {
        cfg.loadFromCluster();
      } catch (e) {
        // Fallback to default file (helps when running outside cluster
        // for diagnostics with a kubeconfig).
        try { cfg.loadFromDefault(); }
        catch { throw new SecretBackendUnavailable(this.id, `kubeconfig load failed: ${(e as Error).message}`); }
      }
      return cfg.makeApiClient(CoreV1Api);
    })();
    return this.apiPromise;
  }

  async get(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const api = await this.getApi();
    let value: string | undefined;

    // Model 1 — bundle Secret with many keys.
    try {
      const resp = await api.readNamespacedSecret(this.bundleSecretName, this.namespace);
      const data = resp?.body?.data ?? resp?.data;
      if (data && typeof data[name] === 'string') {
        value = Buffer.from(data[name], 'base64').toString('utf8');
      }
    } catch (e: any) {
      // 404 just means no bundle exists; fall through to model 2.
      if (e?.response?.statusCode !== 404 && e?.statusCode !== 404) {
        throw new SecretBackendUnavailable(this.id,
          `bundle Secret read failed: ${e?.message ?? String(e)}`);
      }
    }

    // Model 2 — per-secret object.
    if (value === undefined) {
      try {
        const resp = await api.readNamespacedSecret(name, this.namespace);
        const data = resp?.body?.data ?? resp?.data;
        if (data && typeof data[this.perSecretKey] === 'string') {
          value = Buffer.from(data[this.perSecretKey], 'base64').toString('utf8');
        }
      } catch (e: any) {
        if (e?.response?.statusCode === 404 || e?.statusCode === 404) {
          throw new SecretNotFound(name, this.id);
        }
        throw new SecretBackendUnavailable(this.id,
          `per-secret read failed: ${e?.message ?? String(e)}`);
      }
    }

    if (value === undefined || value === '') {
      throw new SecretNotFound(name, this.id);
    }

    this.cache.set(name, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  async healthy(): Promise<boolean> {
    try {
      const api = await this.getApi();
      await api.listNamespacedSecret(this.namespace, undefined, undefined, undefined,
        undefined, undefined, 1); // limit=1 sanity probe
      return true;
    } catch {
      return false;
    }
  }

  /** Test/admin helper — wipe the local cache. */
  _clearCacheForTests(): void { this.cache.clear(); }
}
