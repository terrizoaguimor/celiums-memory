# Celiums Memory for VSCode, Cursor, and Antigravity

Persistent, semantic memory for AI assistants — installable as a single
`.vsix` file in any VSCode-family editor.

This extension does two things:

1. **Registers your Celiums Memory server** with the editor's MCP runtime
   so LLM features (Copilot Chat, Cursor agent, Antigravity tasks) can
   call `recall`, `remember`, `forage`, and the rest of the toolset
   automatically.
2. **Surfaces lightweight commands** in the command palette so you can
   recall or save memories without opening the dashboard:
   - `Celiums: Connect to Memory server`
   - `Celiums: Recall a memory`
   - `Celiums: Remember something` (pre-fills with current selection)
   - `Celiums: Show connection status`
   - `Celiums: Disconnect`
   - `Celiums: Open dashboard in browser`

## Installation

Download the `.vsix` from the
[releases page](https://github.com/terrizoaguimor/celiums-memory/releases)
and install it:

- **VSCode / Antigravity** — `Extensions` panel → `…` menu → `Install from VSIX…`
- **Cursor** — same flow, or drag-and-drop the `.vsix` onto the editor

## Setup

1. Provision a Celiums Memory server (DigitalOcean 1-Click app, self-hosted
   droplet, or `memory.celiums.ai` if you have a tenant).
2. Open the dashboard's **Settings** page and copy the API key (`cmk_…`).
3. In your editor: `Cmd/Ctrl + Shift + P` → `Celiums: Connect`.
4. Paste the URL (e.g. `https://memory.example.com`) and the key.

The extension probes `/health` then `/v1/memories/recall` to confirm the
key is valid before saving anything. It registers the MCP server with
the host editor automatically.

## How registration works

The extension registers a stdio MCP server in every host. The server
runs `npx -y @celiums/mcp@latest --url <YOUR-URL>` with
`CELIUMS_API_KEY` injected via env. The shim translates stdio MCP
into the engine's JSON-RPC at `<YOUR-URL>/mcp`. This is universal —
works in VSCode, Antigravity, Cursor, Claude Desktop, Cline, Continue,
and anything else that follows the MCP stdio convention.

| Host | Backend |
| ---- | ------- |
| **VSCode 1.97+, Antigravity** | `vscode.lm.registerMcpServerDefinitionProvider` returning an `McpStdioServerDefinition`. |
| **Cursor** | Writes/merges `~/.cursor/mcp.json` (`mcpServers.celiums-memory`) with `command`, `args`, `env`. |
| **Older / unknown** | Notification with the stdio config to paste into the host's MCP settings UI. |

Requires `node` + `npx` in `PATH`. The shim is fetched on first launch
and cached.

## Privacy

- The API key is stored via `vscode.SecretStorage` (Keychain on macOS,
  Credential Manager on Windows, libsecret on Linux). Never written
  to plain settings.json.
- The base URL goes in the user-level settings as `celiums.serverUrl`.
- No telemetry. The extension talks to your server and nothing else.

## Building from source

```bash
pnpm install
pnpm --filter celiums-memory-vscode build
pnpm --filter celiums-memory-vscode package    # produces dist/celiums-memory-vscode-X.Y.Z.vsix
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
