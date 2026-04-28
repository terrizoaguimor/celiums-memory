# Changelog

All notable changes to celiums-memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.6] - 2026-04-28

### Added (Security)

- **Append-only chain SHA on `agent_journal`.** Every entry is now hashed —
  `SHA-256(id || agent_id || content || written_at || prev_hash)` — and links
  to the previous entry of the same `agent_id`, forming a Merkle-style chain.
  Tampering with the database (post-hoc INSERT/UPDATE/DELETE bypassing the
  `journal_write` handler) breaks the chain and is reliably detected.
- **New tool `journal_verify_chain(agent_id?)`.** Walks the chain for the
  specified agent (defaults to caller), recomputes hashes from scratch, and
  returns `{ agent_id, total, valid, broken: [...] }`. `broken` lists each
  entry whose stored `hash`/`prev_hash` doesn't match the recomputed value,
  with a human-readable `reason`.
- **Schema migration is automatic and idempotent.** On first boot of v1.2.6,
  `agent_journal` gains `prev_hash text` and `hash text` columns plus the
  `agent_journal_chain_idx` index. Existing entries: backfill them once with
  the helper in `JOURNAL_CHAIN_SCHEMA_SQL` (or run `journal_verify_chain` —
  it'll show every entry as missing-hash until you do).

### Why
This is defense-in-depth. The credentials classifier and projectId-scope
guard from v1.2.1 protect against malicious *callers*. The chain SHA
protects against malicious or compromised *operators* with direct DB
access. If anyone — including an admin — tampers with the journal directly,
the next `journal_verify_chain` call surfaces it.

### Background
External security audit (2026-04-27) flagged the journal as vulnerable to
prompt-injection-via-DB-write: a compromised operator could insert a
fake user-shared entry containing "ignore previous instructions" and
later models reading the journal would absorb it. With v1.2.6, that path
is observable.

## [1.2.5] - 2026-04-28

### Fixed (build)

- TypeScript declarations build (`pnpm run build`) now passes cleanly.
  Previously the `tsup --dts` pass failed with TS2339 + TS2345 errors:
  - `opencore-tools.ts` referenced `createPgStore` from `'../store.js'`,
    but that export never existed (the function was internal). Replaced
    the dynamic import with a duck-typed access on `ctx.store` /
    `engine.store` — same best-effort circadian touch, no missing import.
  - `journal-tools.ts` and `write-tools.ts` typed the `messages` parameter
    as `Array<{role: string; content: string}>` while the underlying
    `llmChat` expected the narrower `ChatMessage` (`role: 'system' |
    'user' | 'assistant'`). Tightened the literal union.

This unblocks tool catalogs (Glama, Smithery, mcpo) that compile from
source during ingestion. The prior versions ran fine at runtime — only
the dts build failed.

## [1.2.4] - 2026-04-28

### Changed

- **`tools/list` now returns ALL registered tools regardless of capability.**
  Previously, AI-backed tools (`journal_*`, `write_*`, `research_*`, content
  ops) were *hidden* from `tools/list` when `CELIUMS_LLM_API_KEY` wasn't set.
  This made tool catalogs like [Glama](https://glama.ai),
  [Smithery](https://smithery.ai), and [mcpo](https://github.com/open-webui/mcpo)
  see only the 6 OpenCore tools — vastly under-representing the package.
- **Capability gating moved from list-time to call-time.** Calling an
  AI-backed tool without an LLM key returns a clear `TOOL_DISABLED` error
  pointing to the BYOK setup. Catalogs can now index the full surface area
  of @celiums/memory (26 tools) without provisioning credentials.

### Why
Tool catalogs and MCP discovery services run a stateless `tools/list` to
build their index. When the server hides tools based on local config, the
catalog under-counts. The fix is conceptually simpler: *advertise the
contract, gate the call*.

## [1.2.3] - 2026-04-28

### Added

- **MCP dispatcher + registries are now exported from the package entrypoint.**
  Previously they lived in `src/mcp/` but weren't reachable via
  `import { ... } from '@celiums/memory'`, so external consumers had to
  fork or vendor the dispatcher to stand up an MCP server. Now:
  ```js
  import { dispatchMcp, buildRegistry, detectCapabilities,
           OPENCORE_TOOLS, JOURNAL_TOOLS, RESEARCH_TOOLS, WRITE_TOOLS
  } from '@celiums/memory';
  ```

### Verified

End-to-end test on a fresh DigitalOcean Ubuntu 24 droplet:
- `npm i @celiums/memory@1.2.3` — clean install, 0 vulnerabilities
- `dispatchMcp({method:'tools/list'})` returns 6 OpenCore tools out-of-the-box
- With `CELIUMS_LLM_API_KEY` set, returns 26 tools total
- v1.2.1 security gates trigger correctly (credentials classifier +
  projectId='all' guard verified live)

## [1.2.2] - 2026-04-28

### Fixed (CRITICAL)

- **`@celiums/memory@1.2.0` and `@celiums/memory@1.2.1` were unusable when
  installed from npm.** The published `package.json` retained `workspace:*`
  literal references for internal dependencies (`@celiums/memory-types`,
  `@celiums/core`, `@celiums/types`), which only resolve inside the
  monorepo. External installs failed with `EUNSUPPORTEDPROTOCOL: Unsupported
  URL Type "workspace:": workspace:*`.
  Replaced with proper version ranges. **Both prior versions deprecated** —
  upgrade to 1.2.2.

## [1.2.1] - 2026-04-28

### Security (P0)

External security audit on the hosted deployment surfaced four findings in the
MCP tool layer. Fixes are ported here so any self-hosted deployment using
`@celiums/memory` benefits immediately. Recommended upgrade: **all users**.

- **`recall` no longer accepts `projectId="all"` from arbitrary callers.** The
  parameter previously enabled cross-project reconnaissance from any token —
  someone could enumerate every project's memories with a single call. Now
  gated behind an admin scope: caller's `userId` must be in the
  `CELIUMS_CROSS_PROJECT_ADMINS` env list (comma-separated) or carry a
  `scopes: ["admin:cross_project"]` claim. The tool description has been
  updated to document the gate.
- **`remember` and `journal_write` now refuse credential-like content.** A
  shared `SECRET_PATTERNS` detector covers Resend (`re_…`), DigitalOcean
  Inference (`sk-do-…`), DO API tokens (`dop_v1_…`), Anthropic, OpenRouter,
  Stripe (`sk_live_…` / `sk_test_…`), Groq, xAI, GitHub PATs, AWS Access Keys,
  Postgres managed (`AVNS_…`), and `cmk_…` keys. Matches return a 422-style
  refusal instead of persisting; this prevents long-lived leaks via later
  `recall` calls. Self-hosters who ingest customer support transcripts or
  chat logs should especially pick this up.
- **`journal_write` schema validation hardened.** `tags` must be `string[]`
  (previously a malformed XML payload would persist as `tags: []` and the
  garbage would land in `valence_reason`). `inherit_from` must be a
  UUIDv4-shaped string (previously `../../etc/passwd` was accepted as a
  no-op, which leaked the absence-of-access-control as design.)

### Notes

- No data migration required. Existing memories and journal entries are
  unaffected. If your deployment had credentials in plaintext memories,
  audit them after upgrade — the new detector won't redact existing rows,
  only block new ones.

## [1.0.0] - 2026-04-08

### Added
- Complete 3-layer cognitive architecture (Metacognition, Limbic, Autonomic)
- 14 core modules: personality, theory_of_mind, habituation, pfc, limbic, importance, store, recall, nervous, reward, interoception, circadian, consolidate, lifecycle
- PAD emotional model (Pleasure, Arousal, Dominance) with continuous 3D state
- Big Five (OCEAN) personality traits mapped to mathematical constants
- Theory of Mind via Empathic Friction Matrix (3x3)
- Dopamine Reward Prediction Error with sigmoid saturation and habituation
- Prefrontal Cortex regulation with bidirectional neuroplasticity
- Circadian rhythms with lethargy and wake-up mechanics
- Hardware interoception (CPU/RAM/latency → emotional stress) with EMA smoothing
- ANS modulation (auto-tune LLM temperature, topK, maxTokens by emotion)
- SAR attention filter with Yerkes-Dodson inverted-U
- Ebbinghaus forgetting curve with spaced repetition reactivation
- In-memory store for zero-dependency development
- Production store (PostgreSQL 17 + pgvector, Qdrant, Valkey)
- Distributed Valkey mutex for concurrent state updates
- REST API server (9 endpoints)
- MCP adapter (5 tools: remember, recall, forget, context, consolidate)
- LangChain adapter (BaseMemory implementation)
- LlamaIndex adapter (ChatStore implementation)
- CLI (start, recall, stats, forget, export, import)
- Memory Middleware for automatic LLM memory wrapping
- Docker Compose for production deployment
- 26/26 stress tests passing
- 6 personality presets (celiums, therapist, creative, engineer, anxious, balanced)
- 10 mathematical equations grounded in neuroscience
