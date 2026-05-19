// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Structured JSON logger — implements ADR-012 §"Logs".
 *
 * Single dep: nothing. One line per event, JSON Lines format. Required
 * fields emitted on every line; optional fields included when set.
 * Redaction goes through the `lib/secrets/redaction` layer so secrets
 * never reach the wire.
 *
 * Sink: stdout by default (container log driver picks it up). Operators
 * can plug a custom sink for testing or for direct shipping to a
 * specific backend (Loki, ELK, Datadog).
 */

import { redactStructured } from '../secrets/redaction.js';
import { getRequestContext } from '../context/storage.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40, fatal: 50,
};

export interface LogFields {
  /** Machine-readable event id, e.g. 'recall.completed', 'auth.denied'. */
  event?: string;
  /** Component name, e.g. 'mcp', 'http', 'memory'. */
  component?: string;
  /** Arbitrary structured fields. Strings + numbers + bools + nested
   *  objects. Sensitive field names are redacted automatically. */
  [k: string]: unknown;
}

export interface LoggerOptions {
  /** Minimum level emitted. Default 'info'. */
  level?: LogLevel;
  /** Sink — receives the already-serialised line. Default writes to stdout. */
  sink?: (line: string) => void;
  /** When true, debug + below may include sensitive content in raw form.
   *  Production: NEVER true. */
  includeContent?: boolean;
  /** Inject a clock for tests. */
  clock?: () => Date;
}

export class Logger {
  private readonly minLevel: number;
  private readonly sink: (line: string) => void;
  private readonly includeContent: boolean;
  private readonly clock: () => Date;

  constructor(opts: LoggerOptions = {}) {
    this.minLevel = LEVEL_RANK[opts.level ?? 'info'];
    this.sink = opts.sink ?? ((line) => { process.stdout.write(line + '\n'); });
    this.includeContent = opts.includeContent ?? false;
    this.clock = opts.clock ?? (() => new Date());
  }

  debug(msg: string, fields: LogFields = {}): void { this.emit('debug', msg, fields); }
  info(msg: string, fields: LogFields = {}): void { this.emit('info', msg, fields); }
  warn(msg: string, fields: LogFields = {}): void { this.emit('warn', msg, fields); }
  error(msg: string, fields: LogFields = {}): void { this.emit('error', msg, fields); }
  fatal(msg: string, fields: LogFields = {}): void { this.emit('fatal', msg, fields); }

  private emit(level: LogLevel, msg: string, fields: LogFields): void {
    if (LEVEL_RANK[level] < this.minLevel) return;
    const ctx = getRequestContext();
    const base: Record<string, unknown> = {
      ts: this.clock().toISOString(),
      level,
      msg,
    };
    if (ctx) {
      base['tenant_id'] = ctx.tenantId;
      base['user_id'] = ctx.principal.userId;
      base['request_id'] = ctx.requestId;
      base['trace_id'] = ctx.traceId;
    }

    // Redact + serialise inside a single try/catch so a misbehaving
    // field (cycles, throwing getters, BigInt, etc.) never bubbles up
    // into the call site. The logger must be totally fail-safe.
    try {
      const merged = { ...base, ...fields };
      const out = (this.includeContent && level === 'debug')
        ? merged
        : (redactStructured(merged) as Record<string, unknown>);
      this.sink(JSON.stringify(out));
    } catch (e) {
      // Last-resort fallback — write the raw message + the error.
      try {
        this.sink(JSON.stringify({
          ts: this.clock().toISOString(), level, msg,
          _logger_error: (e as Error).message,
        }));
      } catch { /* nothing more we can do */ }
    }
  }
}

/** Module-level default logger. Override via setDefaultLogger() in
 *  bootstrap code that wants its own configuration. */
let _defaultLogger = new Logger();

export function defaultLogger(): Logger { return _defaultLogger; }
export function setDefaultLogger(l: Logger): void { _defaultLogger = l; }
