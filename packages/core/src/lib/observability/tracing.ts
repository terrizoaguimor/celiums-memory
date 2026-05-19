// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Tracing primitives — implements ADR-012 §"Traces" minimally.
 *
 * OpenTelemetry-compatible Span interface + a default in-memory recorder
 * suitable for tests. Production deployments wire the real OTel SDK at
 * the boundary (the SDK is operator-installed, not bundled here, to keep
 * the OSS dep tree small).
 *
 * The shape mirrors @opentelemetry/api's Span surface so drop-in is
 * trivial in production code.
 */

import { getRequestContext } from '../context/storage.js';

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanAttributes {
  [k: string]: string | number | boolean | undefined;
}

export interface SpanRecord {
  name: string;
  kind: SpanKind;
  startNs: bigint;
  endNs?: bigint;
  status: SpanStatus;
  attributes: SpanAttributes;
  events: Array<{ name: string; tsNs: bigint; attributes?: SpanAttributes }>;
  traceId?: string;
  parentRequestId?: string;
}

export interface Span {
  setAttribute(key: string, value: string | number | boolean): this;
  setAttributes(attrs: SpanAttributes): this;
  addEvent(name: string, attrs?: SpanAttributes): this;
  setStatus(status: SpanStatus): this;
  end(): SpanRecord;
}

export interface Tracer {
  startSpan(name: string, kind?: SpanKind, attrs?: SpanAttributes): Span;
  /** Run `fn` inside a span. Auto-ends on resolve/reject, sets status
   *  based on outcome. */
  withSpan<T>(name: string, fn: (span: Span) => Promise<T>, kind?: SpanKind): Promise<T>;
}

class InMemorySpan implements Span {
  private readonly record: SpanRecord;
  private ended = false;

  constructor(name: string, kind: SpanKind, attrs: SpanAttributes) {
    const ctx = getRequestContext();
    this.record = {
      name, kind,
      startNs: process.hrtime.bigint(),
      status: 'unset',
      attributes: { ...attrs },
      events: [],
      ...(ctx ? { traceId: ctx.traceId, parentRequestId: ctx.requestId } : {}),
    };
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.record.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: SpanAttributes): this {
    Object.assign(this.record.attributes, attrs);
    return this;
  }
  addEvent(name: string, attrs?: SpanAttributes): this {
    const event: { name: string; tsNs: bigint; attributes?: SpanAttributes } = {
      name, tsNs: process.hrtime.bigint(),
    };
    if (attrs) event.attributes = attrs;
    this.record.events.push(event);
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.record.status = status;
    return this;
  }
  end(): SpanRecord {
    if (this.ended) return this.record;
    this.record.endNs = process.hrtime.bigint();
    this.ended = true;
    return this.record;
  }

  _record(): SpanRecord { return this.record; }
}

/**
 * Default in-memory tracer — records spans into a bounded ring buffer
 * for inspection. Production swaps in @opentelemetry/sdk-node.
 */
export class InMemoryTracer implements Tracer {
  private readonly buffer: SpanRecord[] = [];
  private readonly maxRecords: number;

  constructor(maxRecords: number = 1000) {
    this.maxRecords = maxRecords;
  }

  startSpan(name: string, kind: SpanKind = 'internal', attrs: SpanAttributes = {}): Span {
    return new TrackedSpan(this, new InMemorySpan(name, kind, attrs));
  }

  async withSpan<T>(name: string, fn: (span: Span) => Promise<T>, kind: SpanKind = 'internal'): Promise<T> {
    const span = this.startSpan(name, kind);
    try {
      const result = await fn(span);
      span.setStatus('ok').end();
      return result;
    } catch (err) {
      span.setStatus('error').setAttribute('error.message', (err as Error).message);
      span.addEvent('exception', { 'exception.type': (err as Error).name });
      span.end();
      throw err;
    }
  }

  recordSpan(s: SpanRecord): void {
    this.buffer.push(s);
    if (this.buffer.length > this.maxRecords) {
      this.buffer.shift();
    }
  }

  drain(): SpanRecord[] {
    const out = [...this.buffer];
    this.buffer.length = 0;
    return out;
  }

  size(): number { return this.buffer.length; }
}

class TrackedSpan implements Span {
  constructor(
    private readonly tracer: InMemoryTracer,
    private readonly inner: InMemorySpan,
  ) {}
  setAttribute(k: string, v: string | number | boolean): this { this.inner.setAttribute(k, v); return this; }
  setAttributes(a: SpanAttributes): this { this.inner.setAttributes(a); return this; }
  addEvent(n: string, a?: SpanAttributes): this { this.inner.addEvent(n, a); return this; }
  setStatus(s: SpanStatus): this { this.inner.setStatus(s); return this; }
  end(): SpanRecord {
    const r = this.inner.end();
    this.tracer.recordSpan(r);
    return r;
  }
}
