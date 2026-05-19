// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * P0-C — JSON Schema validator (REDISING §4.3).
 *
 * Two load-bearing properties tested:
 *
 *   1. STRICT path: when /schemas/v1/mcp-inputs/<tool>.schema.json exists
 *      and declares additionalProperties:false, unknown fields are rejected.
 *
 *   2. LENIENT path (the 2026-05-12 regression fix): inline tool
 *      inputSchemas are NOT strictified. MCP clients can pass auxiliary
 *      fields like telemetry tags without being refused, because the
 *      inline schema documents the supported surface, not a closed contract.
 */

import { describe, it, expect } from 'vitest';
import { validateToolInput } from '../mcp/schema-validator.js';

const lenientInlineSchema = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    userId: { type: 'string' },
    importance: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['content'],
};

const strictSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'string' },
  },
  required: ['content'],
};

describe('P0-C — schema validator', () => {
  describe('argument-shape sanity', () => {
    it('rejects non-object args (array)', () => {
      const r = validateToolInput('unknown-tool', ['a', 'b'], {
        inlineInputSchema: lenientInlineSchema,
      });
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        expect(r.error).toContain('expects an object');
      }
    });

    it('rejects non-object args (string)', () => {
      const r = validateToolInput('unknown-tool', 'oops' as any, {
        inlineInputSchema: lenientInlineSchema,
      });
      expect(r.ok).toBe(false);
    });

    it('rejects non-object args (number)', () => {
      const r = validateToolInput('unknown-tool', 42 as any, {
        inlineInputSchema: lenientInlineSchema,
      });
      expect(r.ok).toBe(false);
    });

    it('coerces null/undefined to {}', () => {
      // Inline schema requires 'content', so {} fails — but the failure
      // mode is "schema rejection", not "got wrong type".
      const r = validateToolInput('unknown-tool-nullcheck', null as any, {
        inlineInputSchema: lenientInlineSchema,
      });
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        // Either AJV's required-field message or our shape check —
        // crucially NOT "expects an object" because we coerced null to {}.
        expect(r.error).not.toContain('expects an object');
      }
    });
  });

  describe('lenient inline path (2026-05-12 regression fix)', () => {
    it('accepts the documented surface', () => {
      const r = validateToolInput('remember-lenient-doc', {
        content: 'hello',
        userId: 'mario',
        importance: 0.7,
      }, { inlineInputSchema: lenientInlineSchema });
      expect(r.ok).toBe(true);
    });

    it('accepts auxiliary fields not in the inline schema', () => {
      // This is the WHOLE POINT of the regression fix. A plugin client
      // (Notion bridge, telemetry SDK, internal experiment) may attach
      // extra fields. The lenient path lets them through.
      const r = validateToolInput('remember-lenient-aux', {
        content: 'hello',
        userId: 'mario',
        importance: 0.7,
        // The following fields are NOT declared in lenientInlineSchema:
        client_telemetry: { source: 'notion-bridge' },
        experimental_flag: true,
        trace_id: 'tr-abc',
      }, { inlineInputSchema: lenientInlineSchema });
      expect(r.ok).toBe(true);
    });

    it('still rejects when a required field is missing', () => {
      const r = validateToolInput('remember-lenient-required', {
        userId: 'mario',
      } as any, { inlineInputSchema: lenientInlineSchema });
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        expect(r.error).toContain('Refused');
      }
    });

    it('still rejects when a declared field has the wrong type', () => {
      const r = validateToolInput('remember-lenient-type', {
        content: 'hello',
        importance: 'not-a-number',
      } as any, { inlineInputSchema: lenientInlineSchema });
      expect(r.ok).toBe(false);
    });

    it('still rejects when a declared field violates a range constraint', () => {
      const r = validateToolInput('remember-lenient-range', {
        content: 'hello',
        importance: 1.5,           // max 1.0
      }, { inlineInputSchema: lenientInlineSchema });
      expect(r.ok).toBe(false);
    });
  });

  describe('strict path (when schema declares additionalProperties:false)', () => {
    it('rejects unknown fields when the inline schema is itself strict', () => {
      const r = validateToolInput('strict-inline-tool', {
        content: 'hello',
        unknown_extra: 'rejected',
      }, { inlineInputSchema: strictSchema });
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        // The error message names the unexpected field (AJV reports it).
        expect(r.error).toContain('Refused');
      }
    });

    it('accepts only the declared fields when strict', () => {
      const r = validateToolInput('strict-inline-tool-2', {
        content: 'hello',
      }, { inlineInputSchema: strictSchema });
      expect(r.ok).toBe(true);
    });
  });

  describe('no schema at all', () => {
    it('passes through (with a warning) when no schema is available', () => {
      const r = validateToolInput('totally-unknown-tool-noschema', {
        anything: 'goes',
      });
      // The fallback is permissive — production tools should always ship
      // a schema, but the dispatcher shouldn't crash if one is missing.
      expect(r.ok).toBe(true);
    });
  });

  describe('error reporting', () => {
    it('limits the human error message to 3 errors max + "more" indicator', () => {
      // Build a schema with many required fields, then send nothing.
      const manyRequired = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          c: { type: 'string' },
          d: { type: 'string' },
          e: { type: 'string' },
          f: { type: 'string' },
        },
        required: ['a', 'b', 'c', 'd', 'e', 'f'],
      };
      const r = validateToolInput('many-required-tool', {}, {
        inlineInputSchema: manyRequired,
      });
      expect(r.ok).toBe(false);
      if (r.ok === false) {
        expect(r.error.split('\n').filter((l) => l.includes('more error(s)')).length).toBe(1);
        expect(r.details.length).toBeGreaterThanOrEqual(4);
      }
    });
  });
});
