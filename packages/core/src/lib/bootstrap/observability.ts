// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bootstrap observability — implements ADR-025 §"Observability".
 *
 * Exposes:
 *   - buildBootstrapMetrics() — Counter + Histograms registered into
 *     a caller-supplied MetricsRegistry.
 *   - makeBootstrapObserver() — factory that returns an onDecision
 *     callback wired to those metrics + the structured logger.
 *
 * The dispatcher passes the returned observer to wrapToolResponse so
 * every bootstrap event lands in Prometheus + structured logs without
 * the dispatcher touching the metric handles.
 */

import { Counter, Histogram, type MetricsRegistry } from '../observability/metrics.js';
import type { Logger } from '../observability/logger.js';
import type { BootstrapDecision } from './types.js';

export interface BootstrapMetrics {
  readonly total: Counter;
  readonly latency: Histogram;
  readonly tokens: Histogram;
}

/** Register the three bootstrap metrics into an existing registry.
 *  Keeps ADR-012 buildCoreMetrics surface stable while letting Track 1
 *  ops opt-in to bootstrap telemetry. */
export function buildBootstrapMetrics(registry: MetricsRegistry): BootstrapMetrics {
  return {
    total: registry.register(new Counter({
      name: 'celiums_bootstrap_total',
      help: 'Bootstrap decisions, by agent and reason.',
      labelNames: ['agent_id', 'reason'],
    })),
    latency: registry.register(new Histogram({
      name: 'celiums_bootstrap_latency_seconds',
      help: 'Bootstrap composition latency in seconds.',
      labelNames: ['agent_id'],
      // ADR-025 expects 50-200ms typical; sub-second buckets only.
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    })),
    tokens: registry.register(new Histogram({
      name: 'celiums_bootstrap_tokens',
      help: 'Bootstrap content size in tokens.',
      labelNames: ['agent_id'],
      buckets: [100, 250, 500, 1000, 1500, 2000],
    })),
  };
}

/** Build an `onDecision` callback that:
 *   - increments the total counter labelled by (agent_id, reason)
 *   - observes latency + tokens for first-call wraps
 *   - logs a structured event via the logger
 *
 *  Pass the result to wrapToolResponse({ ..., onDecision }). */
export function makeBootstrapObserver(opts: {
  metrics: BootstrapMetrics;
  logger?: Logger;
}): (info: {
  sessionId: string;
  decision: BootstrapDecision;
  tokens?: number;
  composedInMs?: number;
  channelsPopulated?: string[];
  toolName?: string;
  agentId?: string;
}) => void {
  return (info) => {
    const agent = info.agentId ?? 'unknown';
    opts.metrics.total.inc({ agent_id: agent, reason: info.decision.reason });

    if (info.decision.reason === 'first-call' && info.composedInMs !== undefined) {
      opts.metrics.latency.observe({ agent_id: agent }, info.composedInMs / 1000);
    }
    if (typeof info.tokens === 'number') {
      opts.metrics.tokens.observe({ agent_id: agent }, info.tokens);
    }

    opts.logger?.info('bootstrap.decision', {
      event: 'bootstrap.decision',
      component: 'mcp',
      session_id: info.sessionId,
      decision_reason: info.decision.reason,
      ...(info.toolName ? { tool: info.toolName } : {}),
      ...(info.tokens !== undefined ? { tokens: info.tokens } : {}),
      ...(info.composedInMs !== undefined ? { composed_ms: info.composedInMs } : {}),
      ...(info.channelsPopulated ? { channels: info.channelsPopulated } : {}),
    });
  };
}
