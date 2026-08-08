# Dependencies Rationale

Per CLAUDE.md / NewGuidelines.md §4 principle 6 — every direct dependency
added to a Celiums package needs (a) license check, (b) supply-chain
check, (c) a rationale for choosing it over alternatives.

Indirect / transitive deps are tracked by `pnpm-lock.yaml` (root) and
`pnpm licenses ls`; this file lists the **direct** deps and why they
were picked.

Updates: when a new direct dep lands, add an entry here in the same PR.
CI verifies that every direct dep in `package.json` has a corresponding
entry. Removing a dep removes its entry; a deprecation note may live in
the changelog instead.

---

## Active TypeScript packages

| Dep | Version | License | Why this over alternatives |
|---|---|---|---|
| `@cloudflare/containers` | ^0.0.27 | Apache-2.0 | Cloudflare-supported Worker binding for the native Container runtime. |
| `@modelcontextprotocol/sdk` | ^1.29.0 | MIT | Official MCP stdio server adapter for the Claude Code plugin. |
| `zod` | ^3.25.76 | MIT | Runtime validation for plugin tool inputs. |

### Dev deps

| Dep | Version | License | Why |
|---|---|---|---|
| `@types/pg` | ^8.11.0 | MIT | Types for pg. |
| `tsup` | ^8.0.0 | MIT | Bundler. Faster + simpler than tsc-only or rollup for a library this shape. |
| `typescript` | ^5.7.0 | Apache-2.0 | Required toolchain. |
| `vitest` | ^3.0.0 | MIT | Test runner. Considered: jest — heavier, slower; vitest is the modern default for ESM+TS. |

---

## Banned dependency classes

Per CLAUDE.md / NewGuidelines.md, we DO NOT add direct deps from these
classes without explicit BDFL sign-off:

- **Telemetry / phone-home SDKs at module-load time** — no PostHog,
  Segment, Sentry, etc. as direct deps. Anything that needs telemetry
  goes through a documented opt-in path (ADR-012).
- **License copyleft (GPL, AGPL, LGPL)** — incompatible with the Apache
  2.0 contribution-friendly stance.
- **License "source-available" (BSL, SSPL, Elastic 2.0)** — not OSI-
  approved and creates downstream redistribution friction.
- **Crypto libraries unaudited for our use case** — sticking to Node's
  builtin `crypto` + well-known curated libs (`jose`, future
  `@noble/curves` if/when needed).

---

## Audit log

| Date | Change | PR / ADR |
|---|---|---|
| 2026-05-12 | Initial document landed alongside NewGuidelines reconciliation | ADR-026 |
