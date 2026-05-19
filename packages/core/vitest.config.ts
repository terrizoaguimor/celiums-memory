// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // Sprint D (REDISING §4) tests don't need a real Postgres — the
    // security_audit_log path is exercised via a stubbed `pool` on ctx.
    // For integration tests against a real cluster, run vitest with
    // CELIUMS_TEST_DB_URL set; suites that need it self-skip otherwise.
  },
});
