// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Prometheus metrics — implements ADR-012 §"Metrics".
 *
 * Zero-dep implementation. We do NOT pull in `prom-client` because:
 *   - The Prometheus exposition format is small + well-specified.
 *   - Operators on Tier 1 don't need a 600KB dep tree for one endpoint.
 *   - The library stays self-contained.
 *
 * Three primitive types:
 *   - Counter: monotonically increasing scalar (with optional labels).
 *   - Gauge: arbitrary scalar that can go up or down.
 *   - Histogram: bucketed distribution with configurable buckets.
 *
 * Cardinality discipline (ADR-012): tenant_id, category, status, etc.
 * are allowed labels. user_id and request_id are NEVER labels —
 * unbounded cardinality.
 */

type Labels = Readonly<Record<string, string>>;

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

interface MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: ReadonlyArray<string>;
}

export class Counter implements MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: ReadonlyArray<string>;
  private readonly values = new Map<string, number>();

  constructor(opts: { name: string; help: string; labelNames?: ReadonlyArray<string> }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  inc(labels: Labels = {}, value: number = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  expose(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      // Emit a zero series so the metric is discoverable even pre-traffic.
      lines.push(`${this.name} 0`);
    } else {
      for (const [k, v] of this.values) {
        lines.push(k ? `${this.name}{${k}} ${v}` : `${this.name} ${v}`);
      }
    }
    return lines.join('\n');
  }

  /** Test helper. */
  _peek(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  _reset(): void { this.values.clear(); }
}

export class Gauge implements MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: ReadonlyArray<string>;
  private readonly values = new Map<string, number>();

  constructor(opts: { name: string; help: string; labelNames?: ReadonlyArray<string> }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  set(labels: Labels = {}, value: number): void {
    this.values.set(labelKey(labels), value);
  }

  inc(labels: Labels = {}, value: number = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  dec(labels: Labels = {}, value: number = 1): void {
    this.inc(labels, -value);
  }

  expose(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [k, v] of this.values) {
        lines.push(k ? `${this.name}{${k}} ${v}` : `${this.name} ${v}`);
      }
    }
    return lines.join('\n');
  }

  _peek(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  _reset(): void { this.values.clear(); }
}

const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface HistogramSeries {
  buckets: number[];   // count in each bucket
  sum: number;
  count: number;
}

export class Histogram implements MetricBase {
  readonly name: string;
  readonly help: string;
  readonly labelNames: ReadonlyArray<string>;
  readonly buckets: ReadonlyArray<number>;
  private readonly series = new Map<string, HistogramSeries>();

  constructor(opts: {
    name: string; help: string;
    labelNames?: ReadonlyArray<string>;
    buckets?: ReadonlyArray<number>;
  }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
    this.buckets = opts.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
  }

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { buckets: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.count += 1;
    s.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) s.buckets[i]! += 1;
    }
  }

  expose(): string {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    if (this.series.size === 0) {
      for (const b of this.buckets) {
        lines.push(`${this.name}_bucket{le="${b}"} 0`);
      }
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
    } else {
      for (const [k, s] of this.series) {
        const labelsPrefix = k ? `${k},` : '';
        for (let i = 0; i < this.buckets.length; i++) {
          lines.push(`${this.name}_bucket{${labelsPrefix}le="${this.buckets[i]}"} ${s.buckets[i]}`);
        }
        lines.push(`${this.name}_bucket{${labelsPrefix}le="+Inf"} ${s.count}`);
        const labelsBlock = k ? `{${k}}` : '';
        lines.push(`${this.name}_sum${labelsBlock} ${s.sum}`);
        lines.push(`${this.name}_count${labelsBlock} ${s.count}`);
      }
    }
    return lines.join('\n');
  }

  _peek(labels: Labels = {}): HistogramSeries | undefined {
    return this.series.get(labelKey(labels));
  }

  _reset(): void { this.series.clear(); }
}

/**
 * MetricsRegistry — holds every metric and emits the Prometheus
 * exposition format on demand. The `/metrics` HTTP handler calls
 * `registry.expose()`.
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Counter | Gauge | Histogram>();

  register<T extends Counter | Gauge | Histogram>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`metric "${metric.name}" already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  get(name: string): Counter | Gauge | Histogram | undefined {
    return this.metrics.get(name);
  }

  expose(): string {
    return [...this.metrics.values()].map((m) => m.expose()).join('\n\n') + '\n';
  }

  _reset(): void {
    for (const m of this.metrics.values()) m._reset();
  }

  size(): number { return this.metrics.size; }
}

/** Build the 14 core metrics from ADR-012 §"Core metrics shipped on
 *  day one". The returned object exposes named handles + the
 *  registry so callers can wire them per call site. */
export function buildCoreMetrics(): {
  registry: MetricsRegistry;
  httpRequestsTotal: Counter;
  httpRequestDurationSeconds: Histogram;
  mcpToolCallsTotal: Counter;
  mcpToolDurationSeconds: Histogram;
  memoryStoreTotal: Counter;
  memoryRecallDurationSeconds: Histogram;
  llmCallsTotal: Counter;
  llmTokensTotal: Counter;
  quotaExceededTotal: Counter;
  ratelimitTotal: Counter;
  dbPoolInUse: Gauge;
  qdrantRequestDurationSeconds: Histogram;
  auditWritesTotal: Counter;
  buildInfo: Gauge;
} {
  const registry = new MetricsRegistry();
  return {
    registry,
    httpRequestsTotal: registry.register(new Counter({
      name: 'celiums_http_requests_total',
      help: 'HTTP requests served, by method/route/status.',
      labelNames: ['method', 'route', 'status'],
    })),
    httpRequestDurationSeconds: registry.register(new Histogram({
      name: 'celiums_http_request_duration_seconds',
      help: 'HTTP request latency in seconds.',
      labelNames: ['method', 'route'],
    })),
    mcpToolCallsTotal: registry.register(new Counter({
      name: 'celiums_mcp_tool_calls_total',
      help: 'MCP tool invocations, by tool name and outcome.',
      labelNames: ['tool', 'outcome'],
    })),
    mcpToolDurationSeconds: registry.register(new Histogram({
      name: 'celiums_mcp_tool_duration_seconds',
      help: 'MCP tool latency in seconds.',
      labelNames: ['tool'],
    })),
    memoryStoreTotal: registry.register(new Counter({
      name: 'celiums_memory_store_total',
      help: 'Memories stored, by tenant + type.',
      labelNames: ['tenant_id', 'type'],
    })),
    memoryRecallDurationSeconds: registry.register(new Histogram({
      name: 'celiums_memory_recall_duration_seconds',
      help: 'Recall latency in seconds.',
      labelNames: ['tenant_id'],
    })),
    llmCallsTotal: registry.register(new Counter({
      name: 'celiums_llm_calls_total',
      help: 'LLM provider calls.',
      labelNames: ['provider', 'model', 'outcome'],
    })),
    llmTokensTotal: registry.register(new Counter({
      name: 'celiums_llm_tokens_total',
      help: 'LLM tokens consumed.',
      labelNames: ['provider', 'model', 'direction'],
    })),
    quotaExceededTotal: registry.register(new Counter({
      name: 'celiums_quota_exceeded_total',
      help: 'Quota threshold crossings.',
      labelNames: ['tenant_id', 'category', 'kind'],
    })),
    ratelimitTotal: registry.register(new Counter({
      name: 'celiums_ratelimit_total',
      help: 'Rate-limit decisions.',
      labelNames: ['layer', 'outcome'],
    })),
    dbPoolInUse: registry.register(new Gauge({
      name: 'celiums_db_pool_in_use',
      help: 'Postgres connections currently checked out.',
    })),
    qdrantRequestDurationSeconds: registry.register(new Histogram({
      name: 'celiums_qdrant_request_duration_seconds',
      help: 'Qdrant operation latency in seconds.',
      labelNames: ['op'],
    })),
    auditWritesTotal: registry.register(new Counter({
      name: 'celiums_audit_writes_total',
      help: 'security_audit_log writes by event_kind + decision.',
      labelNames: ['event_kind', 'decision'],
    })),
    buildInfo: registry.register(new Gauge({
      name: 'celiums_build_info',
      help: 'Build identity. Always 1; labels carry the data.',
      labelNames: ['version', 'commit', 'node_version'],
    })),
  };
}
