// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Observability module — implements ADR-012.
 *
 * Three pillars:
 *   - Logger (structured JSON, redaction-aware, context-aware)
 *   - Metrics (Prometheus exposition, 14 core metrics)
 *   - Tracing (Span/Tracer surface compatible with @opentelemetry/api)
 *   - Health (liveness, readiness with probes, version)
 */

export {
  Logger, defaultLogger, setDefaultLogger,
  type LogLevel, type LoggerOptions, type LogFields,
} from './logger.js';

export {
  Counter, Gauge, Histogram, MetricsRegistry, buildCoreMetrics,
} from './metrics.js';

export {
  InMemoryTracer,
  type Tracer, type Span, type SpanKind, type SpanStatus,
  type SpanAttributes, type SpanRecord,
} from './tracing.js';

export {
  HealthService,
  type HealthOptions, type ProbeResult, type ReadinessReport,
  type VersionInfo,
} from './health.js';
