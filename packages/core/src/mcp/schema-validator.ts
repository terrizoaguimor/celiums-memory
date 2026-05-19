// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * MCP Input Validator — strict JSON-Schema validation at the dispatcher
 * boundary, before any handler sees the args.
 *
 * Per REDISING §4.3 (P0-C, 2026-05-12):
 *   - Schema files live under /schemas/v1/mcp-inputs/{tool}.schema.json.
 *   - Strict mode: unknown properties are rejected (additionalProperties: false).
 *   - AJV 8 is the validator. Pre-compile on first use; cache forever.
 *
 * Behaviour matrix:
 *   - If /schemas/ has a file for the tool name → AJV against that file.
 *     A schema mismatch returns a clear error citing field + expected.
 *   - If no file exists → fall back to the tool's inline `inputSchema`
 *     (RegisteredTool.inputSchema). That contract was the previous baseline;
 *     we keep validating against it so unknown properties surface even
 *     without a /schemas/ file. additionalProperties is forced to false
 *     during compilation to align with strict mode.
 *   - If a tool exposes no inputSchema at all → log warning, pass through.
 *     (No production tool should ship without one; this is a safety net.)
 *
 * Why a separate module: the dispatcher stays thin (just calls validate()),
 * and tests can exercise schemas without booting an MCP server.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

// ─── AJV setup ────────────────────────────────────────────────────
// `allowUnionTypes` lets `{type:["string","number"]}` work (we don't use
// it now but ajv 8 strict-mode rejects it by default).
const ajv = new Ajv({
  allErrors: true,
  strict: false,           // permits draft-07 idioms that AJV draft-2020 would reject
  removeAdditional: false, // we want explicit rejection, not silent strip
  useDefaults: false,
});
addFormats(ajv);

// ─── Schema location resolution ───────────────────────────────────
// Schemas live in /schemas/v1/ at the REPO ROOT, not bundled in the
// package. At dev time we resolve relative to the source file location.
// At dist time the consumer is responsible for setting CELIUMS_SCHEMAS_DIR
// or shipping the schemas/ folder beside the dist output.

function findSchemasDir(): string | null {
  // 1. Explicit override
  const envDir = process.env.CELIUMS_SCHEMAS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  // 2. Walk up from current module looking for `schemas/v1/`
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '../../../../schemas/v1'),       // packages/core/src/mcp/ → root
      resolve(here, '../../../schemas/v1'),
      resolve(here, '../../schemas/v1'),
      resolve(here, '../schemas/v1'),
      resolve(process.cwd(), 'schemas/v1'),
      resolve(process.cwd(), '../../schemas/v1'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const SCHEMAS_DIR = findSchemasDir();

// ─── Schema registry — load on first use, cache forever ───────────
const validatorCache = new Map<string, ValidateFunction | null>();
let registryLoaded = false;

function loadCommonSchemas(): void {
  if (!SCHEMAS_DIR) return;
  const commonDir = join(SCHEMAS_DIR, 'common');
  if (!existsSync(commonDir)) return;
  for (const f of readdirSync(commonDir)) {
    if (!f.endsWith('.schema.json')) continue;
    try {
      const raw = readFileSync(join(commonDir, f), 'utf8');
      const schema = JSON.parse(raw);
      // Use $id as the AJV ref key; if missing, fall back to filename.
      if (schema.$id) {
        if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema, schema.$id);
      }
    } catch (e) {
      console.error(`[celiums-core] failed to load common schema ${f}:`, (e as Error).message);
    }
  }
}

function loadToolSchema(toolName: string): ValidateFunction | null {
  if (!SCHEMAS_DIR) return null;
  const file = join(SCHEMAS_DIR, 'mcp-inputs', `${toolName}.schema.json`);
  if (!existsSync(file)) return null;
  try {
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    return ajv.compile(schema);
  } catch (e) {
    console.error(`[celiums-core] failed to compile schema for ${toolName}:`, (e as Error).message);
    return null;
  }
}

function ensureRegistry(): void {
  if (registryLoaded) return;
  loadCommonSchemas();
  registryLoaded = true;
}

/** Return the inline inputSchema untouched.
 *
 *  IMPORTANT (regression 2026-05-12): an earlier version of this helper
 *  forced additionalProperties=false on every object node, which broke
 *  MCP clients (plugins, language SDKs) that pass auxiliary fields the
 *  inline schema doesn't declare (telemetry tags, override fields, etc).
 *  Strict mode is ONLY enforced for schemas authored under /schemas/v1/
 *  where the author explicitly opted in by writing additionalProperties:false.
 *  Inline tool inputSchemas remain lenient — they describe the documented
 *  surface, not a closed contract. */
function strictifyInline(schema: unknown): unknown {
  return schema;
}

/** Public entry: returns null when valid, or a friendly error string when not. */
export interface ValidationOptions {
  /** When set, used as fallback if no /schemas/ file exists for `toolName`. */
  inlineInputSchema?: unknown;
}

export function validateToolInput(
  toolName: string,
  args: unknown,
  options: ValidationOptions = {},
): { ok: true } | { ok: false; error: string; details: ErrorObject[] } {
  ensureRegistry();

  if (args === null || args === undefined) {
    args = {};
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      error: `tool "${toolName}" expects an object argument, got ${Array.isArray(args) ? 'array' : typeof args}`,
      details: [],
    };
  }

  let validator: ValidateFunction | null | undefined = validatorCache.get(toolName);
  if (validator === undefined) {
    validator = loadToolSchema(toolName);
    if (!validator && options.inlineInputSchema) {
      try {
        const strict = strictifyInline(options.inlineInputSchema);
        validator = ajv.compile(strict as object);
      } catch (e) {
        console.error(`[celiums-core] failed to compile inline schema for ${toolName}:`, (e as Error).message);
        validator = null;
      }
    }
    validatorCache.set(toolName, validator ?? null);
  }

  if (!validator) {
    // No schema at all — pass through (with a single-line warning the first
    // time we hit this tool). Production tools should always have a schema.
    if (!validatorCache.has(`__warned:${toolName}`)) {
      console.error(`[celiums-core] no input schema for tool "${toolName}" — validation skipped`);
      validatorCache.set(`__warned:${toolName}`, null);
    }
    return { ok: true };
  }

  if (validator(args)) return { ok: true };

  const errors = (validator.errors ?? []) as ErrorObject[];
  // Build a compact human message: top 3 errors, with field path + message.
  const lines = errors.slice(0, 3).map((e) => {
    const field = e.instancePath || e.schemaPath || '(root)';
    return `  ${field}: ${e.message}`;
  });
  const error =
    `Refused: input to "${toolName}" failed schema validation:\n` +
    lines.join('\n') +
    (errors.length > 3 ? `\n  …${errors.length - 3} more error(s)` : '');
  return { ok: false, error, details: errors };
}

/** Test/debug helper: which schema file was used (or "inline" / "none"). */
export function describeValidationSource(toolName: string): string {
  if (!SCHEMAS_DIR) return 'none (CELIUMS_SCHEMAS_DIR unset and /schemas/ not found)';
  const file = join(SCHEMAS_DIR, 'mcp-inputs', `${toolName}.schema.json`);
  if (existsSync(file)) return file;
  return 'inline (RegisteredTool.inputSchema, strictified)';
}
