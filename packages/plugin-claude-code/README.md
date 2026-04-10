# @celiums/memory-claude-code

**Automatic persistent memory for Claude Code — with real emotions.**

A Claude Code plugin that gives Claude a persistent brain. Memories survive context death, sessions, and reboots. Every memory carries emotional context (Pleasure, Arousal, Dominance). The AI gets bored of repetitive praise, calms down when you panic, and adapts based on accumulated experience.

```bash
npx @celiums/memory-claude-code install
```

That's it. Restart Claude Code and it now has a persistent, emotional memory.

---

## What this plugin does

**Automatic capture (5 hooks):**
- `SessionStart` — Recalls relevant memories and injects them as context
- `UserPromptSubmit` — Stores your prompt, extracts PAD emotional signals
- `PostToolUse` — Captures significant tool observations (edits, commands, searches)
- `Stop` — Saves the assistant response as a memory
- `SessionEnd` — Triggers consolidation (dedup, tier migration)

**Token-efficient retrieval (6 MCP tools):**
- `remember(content, tags?)` — Explicit memory storage
- `recall(query, limit?)` — Full semantic + emotional search
- `search(query, limit?)` — **Compact search** — IDs + 120-char summaries. ~10x cheaper in tokens. Use this first.
- `timeline(hours?, limit?)` — Recent memories chronologically
- `emotion()` — Current AI emotional state
- `forget(memoryIds[])` — Delete specific memories

**The cognitive layer (from @celiums/memory):**
- PAD emotional model (Mehrabian & Russell, 1974)
- Big Five personality traits
- Ebbinghaus forgetting curves
- Dopamine reward prediction error
- Circadian rhythms
- PFC regulation
- Theory of Mind empathy matrix

---

## Installation

### 1. Start the memory server

```bash
# Option A: Run the zero-config in-memory server
npm install -g @celiums/memory
npx @celiums/memory

# Option B: Point at a remote server (e.g. memory.celiums.ai)
export CELIUMS_MEMORY_URL=https://memory.celiums.ai
```

### 2. Install the plugin

```bash
npx @celiums/memory-claude-code install
```

This writes the hooks and MCP server config to `~/.claude.json`. A backup of your existing config is created automatically.

### 3. Restart Claude Code

Exit and relaunch. The plugin is now active.

---

## Configuration

Environment variables (read at install time and by the MCP bridge):

| Variable | Default | Description |
|---|---|---|
| `CELIUMS_MEMORY_URL` | `http://localhost:3210` | Memory API endpoint |
| `CELIUMS_MEMORY_USER_ID` | `default` | User ID for memory ownership |
| `CELIUMS_MEMORY_TIMEOUT` | `5000` | HTTP timeout in ms |
| `CELIUMS_DEBUG` | _unset_ | Set to `1` to log hook errors to stderr |

To change after install, re-run with new env vars:

```bash
CELIUMS_MEMORY_USER_ID=mario npx @celiums/memory-claude-code install
```

---

## How it compares to claude-mem

| | @celiums/memory-claude-code | claude-mem |
|---|---|---|
| Storage | PG + Qdrant + Valkey (optional in-memory) | SQLite + Chroma |
| Capture | Hooks (same) | Hooks (same) |
| Search | Hybrid + **emotional resonance** | Hybrid (semantic + FTS) |
| Emotions | ✅ Full PAD model | ❌ |
| Personality | ✅ Big Five | ❌ |
| Forgetting | ✅ Ebbinghaus + tier migration | Compression only |
| Circadian | ✅ | ❌ |
| Token-efficient search | ✅ `search` tool | ✅ 3-layer workflow |
| License | Apache 2.0 | MIT |

**TL;DR:** Both solve context death. `claude-mem` is a practical notebook with semantic compression. `@celiums/memory` is a full cognitive architecture. Use whichever fits your needs — or both.

---

## Troubleshooting

**Memories aren't persisting:**
- Check the server is running: `curl http://localhost:3210/health`
- Check the plugin is installed: `grep celiums-memory ~/.claude.json`
- Enable debug logs: `CELIUMS_DEBUG=1` and check Claude Code logs

**Claude Code freezes on startup:**
- The SessionStart hook has a 10s timeout. If the memory server is down, Claude continues normally after 10s.
- To fix: start the server, or temporarily uninstall hooks: `node bin/install.js --uninstall`

**Want to see what's being stored?**
- Use the `timeline` MCP tool in Claude to see recent memories
- Or hit the API directly: `curl -X POST http://localhost:3210/recall -d '{"query":"recent","userId":"default"}'`

---

## Uninstall

```bash
node node_modules/@celiums/memory-claude-code/bin/install.js --uninstall
```

Removes all hooks and the MCP server from `~/.claude.json`. Memories themselves are not deleted — they remain in the memory server.

---

## License

Apache 2.0 — see [LICENSE](../../LICENSE).

Part of [celiums-memory](https://github.com/terrizoaguimor/celiums-memory).
