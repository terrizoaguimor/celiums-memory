# Auto-Bootstrap — Integrator Guide

> **Audience**: agent builders integrating Celiums Memory MCP into
> their product (OpenCode, Cursor, Continue, Aider, Cline, custom).
>
> **What this is**: documentation of how Celiums Memory delivers
> deterministic context loading across all MCP clients — including
> those without hook infrastructure (Claude web, ChatGPT, Antigravity).
> Architecture decision codified in [ADR-025](../adr/0025-cross-client-context-bootstrap.md).

---

## TL;DR

Celiums Memory **auto-injects session context** into the first MCP
tool response of every session. Your end users get persistent memory
behavior in your agent product **without you implementing any
plugin / hook / middleware**. The injection is transparent, opt-out-able,
and bounded.

> If you wire up the Celiums Memory MCP server, auto-bootstrap is
> on by default in v1.1+. No code changes required on your side.

---

## Why this exists

MCP clients fall into two camps for context loading:

- **Hook-aware clients** (Claude Code, custom agents with pre-turn
  middleware): can force `turn_context` invocation before each model
  turn. Context loads deterministically.
- **Hook-less clients** (Claude web, ChatGPT with MCP, Cursor,
  Antigravity, the majority of consumer surfaces): depend on the
  model itself deciding to call `recall` / `turn_context`. Models
  tend toward conjecture from in-context information rather than
  tool invocation, especially under conversational momentum.

Documented incident (2026-05): a multi-hour strategic conversation
on Claude web where the model challenged user factual claims based
on conjecture without ever invoking `recall`, despite having tool
access throughout. The user had to ask "did you use recall?" to
surface the failure. This pattern recurs with every integrator's
users who hit a hook-less client.

Auto-bootstrap fixes this at the MCP-server level — context is
loaded **as part of the first tool result** the model requested,
making the behavior identical regardless of client capability.

---

## How it works

1. **Session detection** — the MCP server derives a `session_id`
   from one of:
   - The `X-Celiums-Session` header on the MCP request (preferred).
   - Otherwise: a stable hash of `(user_id, agent_id, connection_open_timestamp)`.
2. **First tool call** — the server checks a cache for the session.
   When **absent**, the server:
   - Composes ≤2000 tokens of context from 5 channels (recent
     memories, high-importance memories, recent journal entries,
     operational rules, recent decisions).
   - Wraps the tool result with a `<session_context auto_loaded="true">`
     block prepended to the tool's first text content item.
   - Marks the session bootstrapped (4h TTL).
3. **Subsequent tool calls** — cache hit; response is unwrapped
   pass-through. No additional latency.
4. **Cache expiry** — after 4 hours of inactivity, the next call
   bootstraps again.

### Response shape (what the model sees)

First call in a session, the tool result text becomes:

```
<session_context auto_loaded="true" session_id="sid_abc...">
## top_semantic_recent
<top memories from last 7 days, importance-weighted>

---

## journal_recent
<last 3 journal entries for this agent>

---

## decisions_30d
<entries tagged 'decision' from last 30 days>
</session_context>

<original tool result text here>
```

The model parses the `<session_context>` block from the tool result
it just asked for, and proceeds with context loaded. No special
training required — modern models handle this naturally.

---

## Opt-out

Three orthogonal ways to disable auto-bootstrap:

### Global (env var)

```bash
CELIUMS_BOOTSTRAP=disabled
```

Skips wrapping for every MCP call. Useful for:
- Benchmark runs requiring deterministic byte-identical tool outputs
- Integration tests
- Debugging context-related issues

### Per-session (request header)

```
X-Celiums-Bootstrap: disabled
```

The header is honoured for the lifetime of the session — once
disabled, the session stays disabled. Useful when an integrator
wants to A/B test their own context-loading vs Celiums'.

### Per-tool (registry tag)

When wiring Celiums Memory MCP, you can pass `exemptTools` to
`dispatchMcp`:

```ts
import { dispatchMcp, MemoryBootstrapStore } from '@celiums/memory';

const bootstrapConfig = {
  store: new MemoryBootstrapStore(),
  turnContext: myTurnContextFn,
  exemptTools: new Set(['my_liveness_probe_tool']),
};

const response = await dispatchMcp(rpcRequest, ctx, env, {
  bootstrap: bootstrapConfig,
});
```

Recommended exemptions: liveness probes, version queries, any tool
whose output the model should NOT mix with bootstrap context.

---

## Wiring it into your dispatcher

If you're using `dispatchMcp` from `@celiums/memory`:

```ts
import {
  dispatchMcp,
  MemoryBootstrapStore,      // or ValkeyBootstrapStore for HA
  buildBootstrapMetrics,
  makeBootstrapObserver,
  MetricsRegistry,
  Logger,
  type TurnContextFn,
} from '@celiums/memory';

const registry = new MetricsRegistry();
const bootstrapMetrics = buildBootstrapMetrics(registry);
const logger = new Logger({ level: 'info' });
const observer = makeBootstrapObserver({ metrics: bootstrapMetrics, logger });

const bootstrapStore = new MemoryBootstrapStore();
// — or for multi-replica Tier 2/3 deployments:
// const bootstrapStore = new ValkeyBootstrapStore({ client: ioredisInstance });

// turnContext: a function the composer calls to fill channels. The
// canonical implementation routes to your memory + journal stores.
const turnContext: TurnContextFn = async ({ agentId, userId, channels }) => {
  // Build channel contents — typically wraps the existing
  // turn_context tool surface. See lib/proactive.ts for the
  // reference implementation.
  return [];
};

// Pass `bootstrap` opts to dispatchMcp on every request:
const response = await dispatchMcp(rpcRequest, ctx, process.env, {
  bootstrap: {
    store: bootstrapStore,
    turnContext,
    headerFlag: rpcRequest.headers?.['x-celiums-bootstrap'],
    onDecision: observer,
  },
});
```

Backwards-compat: omit `bootstrap` and behaviour is unchanged
(no wrapping, exactly like pre-ADR-025).

### Custom dispatcher (not using `dispatchMcp`)

If you've written your own MCP dispatcher:

```ts
import {
  shouldBootstrap, wrapToolResponse, serialiseWrapped,
  deriveSessionId, MemoryBootstrapStore,
} from '@celiums/memory';

async function handleToolCall(rpcRequest, ctx) {
  // ... your existing auth + capability + schema validation ...
  const result = await tool.handler(args, ctx);

  // POST-HANDLER: bootstrap wrap
  const sessionId = deriveSessionId({
    userId: ctx.userId,
    agentId: ctx.agentId,
    connectionOpenedAt: Date.now(),
    explicitSessionId: rpcRequest.headers?.['x-celiums-session'],
  });

  const decision = await shouldBootstrap(
    {
      envFlag: process.env.CELIUMS_BOOTSTRAP,
      headerFlag: rpcRequest.headers?.['x-celiums-bootstrap'],
      toolExempt: false,
      hasSession: Boolean(ctx.userId),
    },
    bootstrapStore,
    sessionId,
  );

  const wrapped = await wrapToolResponse(result, decision, {
    store: bootstrapStore,
    turnContext,
    sessionId,
    agentId: ctx.agentId,
    userId: ctx.userId,
    tenantId: ctx.tenantId,
  }, tool.name);

  // Prepend session_context to result.content[0].text yourself,
  // or use the helper serialiseWrapped for the XML form.
  return wrapped.session_context
    ? injectBlock(result, wrapped.session_context)
    : result;
}
```

---

## Failure modes and degradation

The wrapper is **always best-effort**. Bootstrap failures NEVER
prevent the tool's response.

| Failure | Effect | Observability |
|---|---|---|
| Composer (`turn_context`) throws | Tool response returned unwrapped | `celiums_bootstrap_total{reason="composer-failed"}` |
| Store unreachable (Valkey down) | Treated as cache miss → bootstrap inline; next call bootstraps again | Logged via store's `onError` |
| Composer slow | Bootstrap eats up to ~5s of first-call latency | `celiums_bootstrap_latency_seconds` histogram |
| Response wrapping error | Tool response returned unwrapped + error logged | stderr |

The contract: **a misbehaving bootstrap layer cannot break tool
behavior, only degrade context loading**. Your end users always get
a tool response.

---

## Observability

Three Prometheus metrics expose bootstrap behavior:

| Metric | Type | Labels |
|---|---|---|
| `celiums_bootstrap_total` | Counter | `agent_id`, `reason` (7 values: `first-call`, `cache-hit`, `opt-out-env`, `opt-out-header`, `opt-out-tool`, `no-session`, `composer-failed`) |
| `celiums_bootstrap_latency_seconds` | Histogram | `agent_id` |
| `celiums_bootstrap_tokens` | Histogram | `agent_id` |

The latency histogram only observes first-call wraps; cache hits add
zero latency overhead.

Structured log event `bootstrap.decision` is emitted per call. Filter
your log pipeline on `event: "bootstrap.decision"` for an audit
trail.

---

## Frequently asked

### Will my benchmark numbers change?

Yes — the first call per session pays the composer cost. Typical
~50-200ms. For benchmarks, set `CELIUMS_BOOTSTRAP=disabled` to get
byte-identical outputs.

### Can I read the bootstrap content my end users see?

Yes. The block is `<session_context>...</session_context>` in the
tool result text. UIs that want to surface this to the user can
parse the tag and render the content separately. Most don't —
the model handles it implicitly.

### Does this work with my custom MCP server?

Yes, the primitives (`shouldBootstrap`, `wrapToolResponse`,
`MemoryBootstrapStore`, `composeBootstrap`) are exported from
`@celiums/memory`. You can compose them around any dispatcher.

### Is the bootstrap content tenant-scoped?

Yes. The composer respects `tenantId` from the request context.
A user in tenant A sees only tenant A's memories; a user in
tenant B sees tenant B's. No cross-tenant context leakage.

### What about anonymous / unauthenticated users?

Bootstrap is skipped (`reason: no-session`). Tools work; no
context preload. Documented in ADR-025.

### Can I customize which channels are populated?

Yes. Pass `channels` in the bootstrap config:

```ts
const bootstrapConfig = {
  store: bootstrapStore,
  turnContext,
  channels: ['top_semantic_recent', 'decisions_30d'],
  // skips operational_rules, top_semantic_alltime, journal_recent
};
```

### How do I invalidate a session bootstrap?

`bootstrapStore.invalidate(sessionId)`. Useful when the user has
clearly switched contexts and you want the next call to refresh.

---

## Related ADRs

- [ADR-025 — Cross-Client Context Bootstrap](../adr/0025-cross-client-context-bootstrap.md) (architecture)
- [ADR-026 — Two-Track Product Strategy](../adr/0026-two-track-product-strategy.md) (why auto-bootstrap is critical for Track 1 horizontal infrastructure)
- [ADR-012 — Observability Stack](../adr/0012-observability-stack.md) (metric naming conventions)
