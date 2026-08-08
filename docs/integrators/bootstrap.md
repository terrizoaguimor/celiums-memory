# Auto-Bootstrap Integrator Guide

The production path is the authenticated native Rust MCP/HTTP server behind
the Cloudflare Worker and one Durable Object per tenant. The old TypeScript
dispatcher and in-process bootstrap stores were removed in Phase 10.

## Request Flow

1. The Worker validates `Authorization: Bearer <key>` and
   `x-celiums-tenant-id`.
2. The tenant selects one Durable Object and its Container generation.
3. The Container forwards MCP/HTTP requests to the native Rust server.
4. The Rust engine composes recall, journal and governance behavior from the
   tenant-scoped durable store.

## Claude Code

The Claude Code plugin provides hook-based session context and capture. It
uses the same MCP endpoint and never embeds a storage engine. Configure:

```sh
export CELIUMS_MEMORY_URL=https://api.example.invalid
export CELIUMS_TENANT_ID=tenant-a
export CELIUMS_API_KEY=cmk_example
npx @celiums/memory-claude-code install
```

## Failure Behavior

Hooks are best-effort. If the server is unavailable, the hook exits without
blocking the host agent. Rust MCP errors remain explicit and are returned as
JSON-RPC errors or structured tool errors; no storage fallback is attempted.
