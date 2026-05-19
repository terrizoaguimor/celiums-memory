// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Health endpoints — implements ADR-012 §"Health endpoints".
 *
 *   - /healthz  liveness. 200 if the process is up. No deps.
 *   - /readyz   readiness. 200 only when Postgres, Qdrant, Valkey
 *               are reachable within probeTimeoutMs.
 *   - /version  build info — useful for canary verification.
 *
 * The pure-function design means the HTTP wrapper can be Hono,
 * Express, anything. The wrapper calls liveness/readiness/version and
 * maps the result to HTTP.
 */

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, ProbeResult>;
}

export interface HealthOptions {
  /** Per-probe timeout. Default 2000ms. */
  probeTimeoutMs?: number;
  /** Named probes — return ok=true within the timeout to be considered ready. */
  probes?: Record<string, () => Promise<boolean>>;
}

export interface VersionInfo {
  version: string;
  commit?: string;
  builtAt?: string;
  nodeVersion?: string;
}

export class HealthService {
  private readonly probeTimeoutMs: number;
  private readonly probes: Record<string, () => Promise<boolean>>;
  private readonly versionInfo: VersionInfo;

  constructor(versionInfo: VersionInfo, opts: HealthOptions = {}) {
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
    this.probes = opts.probes ?? {};
    this.versionInfo = versionInfo;
  }

  /** Liveness — 200 if we can answer at all. */
  liveness(): { ok: true } {
    return { ok: true };
  }

  /** Readiness — checks every registered probe in parallel with a
   *  shared timeout. ok=true only if EVERY probe returned true. */
  async readiness(): Promise<ReadinessReport> {
    const checks: Record<string, ProbeResult> = {};
    const names = Object.keys(this.probes);
    const startAll = performance.now();

    const results = await Promise.all(names.map(async (name) => {
      const probe = this.probes[name]!;
      const start = performance.now();
      try {
        const ok = await Promise.race([
          probe(),
          new Promise<boolean>((_, reject) => {
            setTimeout(() => reject(new Error('probe timeout')), this.probeTimeoutMs);
          }),
        ]);
        return { name, ok, latencyMs: roundLatency(performance.now() - start) };
      } catch (e) {
        return {
          name, ok: false,
          latencyMs: roundLatency(performance.now() - start),
          error: (e as Error).message,
        };
      }
    }));

    for (const r of results) {
      const entry: ProbeResult = { ok: r.ok, latencyMs: r.latencyMs };
      if (r.error !== undefined) entry.error = r.error;
      checks[r.name] = entry;
    }
    const ok = results.every((r) => r.ok);
    void startAll;
    return { ok, checks };
  }

  version(): VersionInfo { return this.versionInfo; }
}

function roundLatency(ms: number): number {
  return Math.round(ms * 100) / 100;
}
