# Changelog

All notable changes to celiums-memory will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
