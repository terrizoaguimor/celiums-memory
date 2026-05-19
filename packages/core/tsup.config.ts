// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import { defineConfig } from 'tsup';

/**
 * tsup auto-loads this file and MERGES it with the CLI flags in the
 * package.json "build" script (entrypoints, --format esm, --dts,
 * --external better-sqlite3/pg/@qdrant/ioredis). We only add `noExternal`
 * here.
 *
 * WHY (incident 2026-05-16): with no config, tsup externalizes every
 * `dependencies` entry. In the distroless runtime the app runs from
 * /app/dist/quickstart.js, so Node resolves bare imports against
 * /app/node_modules. pnpm's strict workspace layout leaves some deps only
 * under /app/packages/core/node_modules (not an ancestor of /app/dist) →
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'ajv'` → CrashLoop, prod
 * outage. ajv/ajv-formats are pure-JS (no native bindings) so bundling
 * them into the dist is safe and removes the runtime-resolution
 * dependency entirely. Native/heavy deps (better-sqlite3, pg, qdrant,
 * ioredis) stay EXTERNAL — they must not be bundled.
 *
 * If the off-prod boot-check surfaces another externalized pure-JS dep
 * that fails to resolve, add it here (iterate off-prod, never in prod).
 */
export default defineConfig({
  noExternal: ['ajv', 'ajv-formats'],
});
