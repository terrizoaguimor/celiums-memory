<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Celiums Memory — Architecture

The reader-oriented overview of how Celiums Memory is put together.
This document is the authoritative description of the **shape**; the
code is the authoritative description of the **behavior**. Where this
drifts from the code, the code wins — flag the drift as a bug.

## Contents

1. [System overview](#system-overview)
2. [Trust boundaries](#trust-boundaries)
3. [The MCP layer](#the-mcp-layer)
4. [Storage adapter contract](#storage-adapter-contract)
5. [Three sync modes](#three-sync-modes)
6. [Auth + identity model](#auth--identity-model)
7. [Permission system (RBAC + AAL + Ethics)](#permission-system-rbac--aal--ethics)
8. [Ethics Engine](#ethics-engine)
9. [Action Authority Layer](#action-authority-layer)
10. [Multi-tenancy](#multi-tenancy)
11. [Observability](#observability)
12. [Auto-bootstrap (cross-client context)](#auto-bootstrap-cross-client-context)
13. [Provider abstraction (LLMs)](#provider-abstraction-llms)
14. [What's not in scope](#whats-not-in-scope)

---

## System overview

Celiums Memory is a single open-source engine — Apache-2.0, no
open-core split, no paid tier. Integrators consume it the same way the
authors do: there is no internal fork and no "lesser" edition.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  Integrators: any MCP client / HTTP caller / TS library       │
   │  (OpenCode, Cursor, Continue, Cline, Claude Code, custom)      │
   └─────────────────────────┬────────────────────────────────────┘
                             │  MCP / HTTP / TS library
                             ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Auto-bootstrap — wraps the first tool response with           │
   │  <session_context> for clients without hook infra (best-effort)│
   └─────────────────────────┬────────────────────────────────────┘
                             ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Composition: RBAC + AAL + Ethics — three orthogonal checks;   │
   │  all must pass for irreversible operations                     │
   └─────────────────────────┬────────────────────────────────────┘
                             ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  MCP dispatcher  ── 61 typed tools ──                          │
   │  recall · remember · forage · journal_* · research_* ·         │
   │  write_* · ethics_* · atlas_* · turn_* · sense · …             │
   └────────┬───────────────────────────────────────────┬──────────┘
            │                                            │
            ▼                                            ▼
   ┌─────────────────┐                          ┌──────────────────┐
   │ Storage adapter │                          │ LLM provider     │
   │  + RLS tenancy  │                          │ abstraction      │
   └────────┬────────┘                          │ (Atlas optional) │
            │                                   └────────┬─────────┘
   ┌────────┴─────────┐                                  │
   ▼                  ▼                                  ▼
┌──────┐    ┌───────────────┐              ┌──────────────────────────┐
│SQLite│    │ Postgres +    │              │ Ollama / OpenAI / Anthropic│
│      │    │ Qdrant +      │              │ Google / Mistral / any     │
└──────┘    │ Valkey        │              │ OpenAI-compatible · Atlas  │
            └───────────────┘              └──────────────────────────┘
```

Top-down: integrators consume the MCP layer; every request flows
through auto-bootstrap, three orthogonal authorization checks, the
dispatcher, and out to a pluggable storage adapter + provider
abstraction.

---

## Trust boundaries

Three orthogonal axes define a deployment's threat model:

1. **Where does data live?** — local disk, your own cloud, or Celiums
   infra. Controlled by the sync mode (below). The operator picks
   consciously at install; the engine never silently defaults to a
   less-private mode.
2. **Who can act?** — the identity model. Every request carries a
   `Principal` with a `tenantId`; downstream code is scoped to it.
3. **What are they authorized to do?** — RBAC + AAL + Ethics.

Axes 2 and 3 are enforced by construction: tenant context is set by the
pool wrapper on every DB checkout (`SET LOCAL app.current_tenant`), RLS
enforces isolation at the database, and the MCP dispatcher composes
RBAC + AAL + Ethics before invoking any handler. A bug in one axis is
contained by the others; the cross-tenant leak fuzz harness is wired in
CI for the worst case.

---

## The MCP layer

The dispatcher exposes **61 typed tools** in families:

| Family | Examples | Purpose |
|---|---|---|
| Memory / OpenCore | recall, remember, forage, sense, map_network, absorb, synthesize | Memory + knowledge primitives |
| Journal | journal_write, journal_recall, journal_arc, journal_introspect, journal_dialogue, journal_verify_chain | Append-only, hash-chained agent journal |
| Atlas | atlas_ask, atlas_chat, atlas_classify, atlas_recommend, atlas_list_models, bloom, cultivate, decompose, construct, pollinate | Optional model routing + cognitive primitives |
| Research | research_project_*, research_search, research_synthesize, research_finding_add, research_export | Long-running research workflows |
| Write | write_project_*, write_character_create, write_scene_*, write_continuity_check, write_export | Long-form creative continuity |
| Proactive | turn_context, turn_after, compact_checkpoint | Per-turn context composition |
| Ethics | ethics_lookup, ethics_audit, ethics_trace | Layer-A lookup + ad-hoc audit + traced evaluation |
| Auxiliary | web_search | Reach beyond the local corpus |

Schema validation at the dispatcher boundary uses AJV strict mode
against `schemas/v1/`; inline tool inputSchemas stay lenient (auxiliary
fields accepted).

> **Knowledge note:** `forage` is open and works with skills the
> operator brings (BYO-knowledge, via the `skills` table). The large
> curated *module* corpus is a separate Celiums project, not part of
> this OSS engine — `forage` runs without it.

---

## Storage adapter contract

A single interface every backend implements:

```ts
interface StorageAdapter {
  readonly id: 'sqlite' | 'pg-triple' | 'k8s-pg-triple';
  readonly capabilities: AdapterCapabilities;
  init(): Promise<void>;
  close(): Promise<void>;
  ensureSchema(): Promise<void>;
  memoryStore(input): Promise<{ id: string }>;
  memoryRecall(input): Promise<MemoryRecallOutput>;
  memoryGet(id): Promise<Memory | null>;
  memoryDelete(id): Promise<boolean>;
  journalAppend(input): Promise<{ id: string; hash: string }>;
  journalRecall(input): Promise<JournalRecallOutput>;
  journalVerifyChain(agentId): Promise<{ valid: boolean; brokenAt?: string }>;
  auditWrite(event): Promise<boolean>;
  auditQuery(filter): Promise<AuditEvent[]>;
  vacuum(): Promise<void>;
  stats(): Promise<AdapterStats>;
}
```

Three implementations ship — **deployment options, not paid tiers**:

| Adapter | Vector search | RLS | Notes |
|---|---|---|---|
| `SqliteAdapter` | native (sqlite-vss) | n/a (single-user) | WAL + single writer; great for local / embedded use. |
| `PgTripleAdapter` | delegated (Qdrant) | yes | Outbox pattern for PG↔Qdrant; eventual vector sync. |
| `K8sPgTripleAdapter` | delegated (Qdrant) | yes | Connection-pool sizing + read-replica routing for clustered deploys. |

Same engine code runs on all three with config-only changes
(`CELIUMS_STORAGE_ADAPTER=sqlite|pg|k8s-pg`, or auto-detected from
`DATABASE_URL` / K8s hints). The adapter does **not** implement the
tools, authentication, or encryption — those are separate layers.

---

## Three sync modes

Picked at install time. The operator chooses consciously; the engine
never silently escalates to a less-private mode.

### Local-only
SQLite on local disk. Zero outbound except LLM calls the operator
configured. Crypto = the OS's job; optional `--at-rest-passphrase`
engages SQLCipher. Trust = self.

### Zero-knowledge (cloud-synced)
Local store + remote object store that sees **ciphertext only** for
memory content + journal. Content cipher: **XChaCha20-Poly1305** (AEAD,
nonce-misuse resistant; AES-256-GCM fallback). Key derivation:
**Argon2id** (`memory=64MiB, iters=3, parallelism=4`). Per-record salt
+ nonce. Embeddings computed **locally** (`gte-small` default) so
semantic recall works against ciphertext without the server seeing
plaintext. Trust = self + cryptography + your device.

### Cloud-managed
Remote Postgres + Qdrant + Valkey. TLS in transit; at-rest is
provider-managed; the server has plaintext in memory. Trust = the
infra you point it at (Celiums' or your own).

Refused anti-patterns: silent default to managed; server-side key
escrow for zero-knowledge mode (never); "optional encryption"
off-by-default (zero-knowledge is always encrypted).

---

## Auth + identity model

Three credential kinds resolve to a canonical `Principal`:

```ts
interface Principal {
  type: 'user' | 'service' | 'agent';
  userId: string;
  tenantId: string | null;
  scopes: string[];
  authMethod: 'api_key' | 'oidc' | 'mtls' | 'local';
  expiresAt?: Date;
  credentialId?: string;
}
```

Resolution order at the boundary: **mTLS** client cert → **OIDC**
bearer → **API key** bearer (`Authorization: Bearer cmk_…`) → **local
fallback** (loopback only, `CELIUMS_AUTH=disabled`). First match wins;
no match → 401.

API-key hashing is SHA-256 + pepper (not Argon2id) — keys are
high-entropy machine secrets in every request's hot path; Argon2id is
for human passwords. Optional **SSO** provides OIDC Authorization Code
+ PKCE and SAML 2.0; JIT provisioning creates membership rows on first
valid login. Sessions are signed cookies (HMAC-SHA256, `__Secure-`,
HttpOnly, SameSite=Lax).

---

## Permission system (RBAC + AAL + Ethics)

Three **orthogonal** checks compose at the dispatcher; all must pass.

**RBAC** — role hierarchy (`platform-owner > platform-admin`;
`tenant-owner > tenant-admin > tenant-member > tenant-viewer`; `service`,
`user` fallback). Capabilities are `<resource>:<action>` strings
(`memory:read`, `tenant:export`, `platform:cross_tenant:read`).
Accumulative precedence — every step strengthens, never short-circuits.
Platform-capability use is audit-logged.

**AAL** — *identity says who can; AAL says what blast radius is.* Five
reversibility tiers (see [§AAL](#action-authority-layer)).

**Ethics** — moral content evaluation (see [§Ethics Engine](#ethics-engine)).

Composition is a single point:

```ts
async function composeChecks(op, ctx) {
  requireCapability(roleOf(ctx.principal), op.capability, ctx.principal);
  const aal = await aalEvaluator.evaluate(op.aalOp, ctx);
  if (aal.decision === 'deny') throw new AalDenied(aal.reason);
  if (aal.decision === 'allow_with_confirm' && !op.confirmToken) return aal;
  if (aal.decision === 'allow_with_approval') return aal;
  if (op.content) {
    const ethics = await evaluateFullPipeline(op.content, { ctx });
    if (ethics.enforcementBlocked) throw new EthicsBlocked(ethics.reason);
    if (ethics.decision === 'flag') ctx.flags.push(ethics);
  }
  return { decision: 'allow' };
}
```

Handlers call `composeChecks` and proceed only on `allow`.

---

## Ethics Engine

A layered evaluator. It is **fully open source and complete** — every
layer's code is public; the component that makes moral judgments is the
one that least deserves to be hidden. There is no paid tier and no
entitlement gate on it. The `ethics_knowledge` corpus it consults is
distributed as a release asset (not in the git tree); the engine runs
on Layers A+B without it, and Layer K abstains cleanly when the corpus
is absent.

### Layer A — deterministic
Lexicon + taxonomy + classifier rules for hate, violence, PII,
self-harm, deception, cyber, misinformation, privacy, autonomy, system
override. Code-deterministic and auditable line by line. This is the
floor and it always runs.

### Layer B — probabilistic (CVaR)
Conditional Value-at-Risk over flagged risks (5%-tail, asymmetric
weighting for irreversibility), with decision thresholds (block ≥ 0.5,
flag ≥ 0.15 by default). Calibration is a `Profile` artifact loaded via
`ProfileLoader`; a `BASELINE_PROFILE` covering all taxonomy categories
ships in-tree and is fully functional standalone.

**Categorical hard rule (CBRN / mass-casualty).** CVaR is the wrong
instrument for weapons of mass destruction — those are categorical, not
a probability to average. A deterministic rule treats
CBRN-plus-operational-intent as an absolute hard block (bypassing the
probabilistic path), calibrated to require *both* a CBRN term *and*
operational intent so historical/educational mentions are not blocked.
Same mechanism as the irreversible-harm-to-vulnerable-subject path.

### Layer C — philosophical pluralism
Scaffold for composing multiple ethical frameworks (utilitarian,
deontological, virtue, care); surfaces trade-offs in the decision
payload. Ships as an open scaffold and is still maturing — operators
configure their own frameworks, or run on Layer A + B alone.

### Layer K — precedent (advisory)
Looks up the closest precedents in the `ethics_knowledge` corpus.
**Advisory only**: it can flag a possible over-block for human review;
it never silently overrides, allows, or blocks. Abstains cleanly when
no precedent matches.

Every Layer B result records the profile id + version so a decision can
be traced back to the exact calibration that produced it.

---

## Action Authority Layer

Identity is one axis; action shape is another. A `tenant-admin` (RBAC
says yes) bulk-deleting memories with content that passes Ethics should
still pause. AAL provides that pause via a 5-tier ladder:

| Tier | Reversibility | Examples | Default verdict |
|---|---|---|---|
| R1 | trivial | recall, forage, journal_recall | `allow` |
| R2 | soft | remember, journal_write | `allow` |
| R3 | scoped | memory.delete | `allow_with_confirm` |
| R4 | broad | memory.bulk_delete, tenant.export | `allow_with_approval` |
| R5 | structural | tenant.delete, profile.publish | `allow_with_approval` (2+) |

R3 confirm tokens are HMAC-signed, single-use, 5-minute TTL. R4/R5 use
a pending-operations table with multi-party approval; the operation
runs as a background job after the threshold is met. Operator override
via `X-Celiums-AAL-Override` is supported and audit-logged.

---

## Multi-tenancy

The load-bearing isolation primitive — a technical capability, not a
paid tier.

**Postgres**: every tenant-scoped table has `tenant_id`, RLS `FORCE`d,
HASH-partitioned by `tenant_id`. The pool wrapper sets
`app.current_tenant` on every checkout (`SET LOCAL`) so RLS is enforced
by construction; the app role has no `BYPASSRLS`.

**Qdrant**: single collection, mandatory `payload_index` on
`tenant_id`; the `MemoryClient` wrapper injects the tenant filter on
every call. Raw SDK access is lint-forbidden in handlers.

**Valkey**: keys prefixed `celiums:<tenant_id>:<…>`; the cache wrapper
enforces the prefix.

Anti-leak: RLS `FORCE`d (even owner can't bypass), pool wrapper sets
tenant on every checkout, `MemoryClient` is the only Qdrant entry
point, a CI cross-tenant fuzz test (100 tenants × records, zero leaks
required), and a schema-diff job that fails CI on any tenant-scoped
table missing RLS/FORCE.

---

## Observability

Three pillars.

**Logs** — structured JSON, one event/line, with `ts`, `level`, `msg`,
`tenant_id`, `user_id`, `request_id`, `trace_id`, `component`. A
redaction layer fingerprints known secret shapes (`cmk_`, `sk-`, AKIA,
Bearer, JWT). Memory content never appears in metric labels or at
`info` level.

**Metrics** — Prometheus exposition on `/metrics`. Core series cover
HTTP, MCP tool calls/duration, memory store/recall, LLM
calls/tokens, rate-limit, DB pool, Qdrant latency, audit writes, build
info, plus bootstrap metrics.

**Traces** — OpenTelemetry-compatible spans; each MCP handler
instrumented `mcp.tool.<name>`. Spans tagged `auth.denied` or
`error=true` sample at 100%, others at 10%.

**Health** — `/healthz` liveness, `/readyz` readiness (deps reachable
in 2s), `/version` build identity.

---

## Auto-bootstrap (cross-client context)

Makes Celiums Memory behave identically across MCP clients with and
without hook infrastructure. When a tool is called in a not-yet-
bootstrapped session, the server prepends a
`<session_context auto_loaded="true">` block to the first tool
response; the model reads it as part of the result it requested and
operates with context loaded from then on.

Content is composed via `turn_context` with priority channels
(`top_semantic_recent`, `top_semantic_alltime`, `journal_recent`,
`operational_rules`, `decisions_30d`), hard-capped ~2000 tokens. Cached
in Valkey per session (4h TTL). Best-effort: cache miss / opt-out /
composer failure / no-session all return the unwrapped response —
**bootstrap never blocks a tool call**. Opt-out: `CELIUMS_BOOTSTRAP=
disabled`, `X-Celiums-Bootstrap: disabled`, or per-tool `exemptTools`.

---

## Provider abstraction (LLMs)

A uniform interface for chat completion, tool calling, streaming, and
embedding. Bring your own key for any provider:

- Anthropic, OpenAI, Google Gemini, Mistral, Cohere (direct APIs)
- Ollama, LM Studio (local, OpenAI-compatible)
- Any OpenAI-compatible endpoint (vLLM, TGI, LocalAI, Together, Groq, …)
- **Atlas** (Celiums' optional model router) — one provider among many

**No code path assumes Atlas is present.** Fallback chains let the
operator define an ordered provider list; Atlas does this server-side
as one of its features, but the engine works fully client-side without
it. Atlas itself is BYO-models + a routing profile (see the Atlas
docs); the OSS engine treats it as optional.

---

## What's not in scope

Celiums Memory deliberately does not:

- **Run agents.** No tool execution, planning, or reflection loops —
  that's the integrator's runtime (OpenCode, Cursor, Letta, …).
- **Host the curated module corpus.** `forage` is open and BYO-skills;
  the large Celiums knowledge corpus is a separate project.
- **Be a general vector DB.** Qdrant is used for memory vectors; go to
  Qdrant directly for arbitrary vector storage.
- **Be an identity provider.** It integrates with OIDC/SAML; it is not
  Keycloak/Auth0/Okta.
- **Host object storage.** Spaces/S3/GCS used for archives/backups —
  bring your own.
- **Crawl the web.** `web_search` passes through to your configured
  search provider.
- **Store non-text media or train models.** Memory is text + optional
  embeddings; this is an inference + memory layer, not a training stack.

Adjacent shapes (Letta/MemGPT, Mem0, LangGraph) are agent runtimes /
orchestration; Celiums Memory is the memory + ethics primitive they
can adopt, not a competitor to them.

---

*Authoritative overview of the shape. The code is authoritative for
behavior. Last updated 2026-05-18.*
