# Connecting MCP clients to your Celiums Memory server

Every MCP-aware editor or chat client connects to Celiums the same way:
spawn `npx -y @celiums/mcp@latest --url <YOUR-URL>` over stdio with
the API key in the environment. Only the **path** of the config file
and the **top-level JSON key** differ between hosts.

## What you'll need

- **Server URL** — the base URL of your Celiums Memory server,
  e.g. `https://memory.example.com` (1-Click droplet with FQDN mode)
  or `https://<your-droplet-ip>` (1-Click droplet with IP mode).
- **API key** — copy it from the dashboard's **Settings** page, or
  from `/root/.celiums/api-key` on the droplet over SSH. Starts with
  `cmk_…`.
- **`node` 18+ and `npx`** in your `PATH`. The `@celiums/mcp` shim is
  fetched on first launch and cached.

In every snippet below, replace:

| Placeholder      | Replace with                          |
| ---------------- | ------------------------------------- |
| `YOUR-CELIUMS-URL` | your server's base URL              |
| `YOUR_API_KEY`     | your `cmk_…` key                    |

## File-path table

| Host                | Config path (macOS)                                                                | Config path (Linux)                                            | Config path (Windows)                                       | Schema |
| ------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | :----: |
| Claude Desktop      | `~/Library/Application Support/Claude/claude_desktop_config.json`                  | `~/.config/Claude/claude_desktop_config.json`                  | `%APPDATA%\Claude\claude_desktop_config.json`               | **A**  |
| Claude Code         | `~/.claude/mcp.json`                                                               | `~/.claude/mcp.json`                                           | `%USERPROFILE%\.claude\mcp.json`                            | **A**  |
| Cursor (global)     | `~/.cursor/mcp.json`                                                               | `~/.cursor/mcp.json`                                           | `%USERPROFILE%\.cursor\mcp.json`                            | **A**  |
| Cursor (workspace)  | `<repo>/.cursor/mcp.json`                                                          | `<repo>/.cursor/mcp.json`                                      | `<repo>\.cursor\mcp.json`                                   | **A**  |
| Windsurf            | `~/.codeium/windsurf/mcp_config.json`                                              | `~/.codeium/windsurf/mcp_config.json`                          | `%USERPROFILE%\.codeium\windsurf\mcp_config.json`           | **A**  |
| Cline / Continue    | host's settings UI (paste the JSON value of the `mcpServers` object)               | same                                                           | same                                                        | **A**  |
| VSCode (user)       | `~/Library/Application Support/Code/User/mcp.json`                                 | `~/.config/Code/User/mcp.json`                                 | `%APPDATA%\Code\User\mcp.json`                              | **B**  |
| VSCode (workspace)  | `<repo>/.vscode/mcp.json`                                                          | `<repo>/.vscode/mcp.json`                                      | `<repo>\.vscode\mcp.json`                                   | **B**  |
| Antigravity (user)  | `~/Library/Application Support/Antigravity/User/mcp.json`                          | `~/.config/Antigravity/User/mcp.json`                          | `%APPDATA%\Antigravity\User\mcp.json`                       | **B**  |

If a host isn't listed, check whether its docs follow Schema A
(`mcpServers`) or Schema B (`servers` with `type: "stdio"`) and pick
the matching snippet.

## Schema A — `mcpServers`

Used by: **Claude Desktop, Claude Code, Cursor, Windsurf, Cline,
Continue, and most file-based MCP clients.**

```json
{
  "mcpServers": {
    "celiums-memory": {
      "command": "npx",
      "args": [
        "-y",
        "@celiums/mcp@latest",
        "--url",
        "YOUR-CELIUMS-URL"
      ],
      "env": {
        "CELIUMS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

If the file already exists, merge the entry inside the existing
`mcpServers` object — don't replace the whole document.

## Schema B — `servers` with `type: "stdio"`

Used by: **VSCode 1.97+, Antigravity, and any other VSCode-style
host that follows the official MCP user-settings shape.**

```json
{
  "servers": {
    "celiums-memory": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@celiums/mcp@latest",
        "--url",
        "YOUR-CELIUMS-URL"
      ],
      "env": {
        "CELIUMS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Same merge rule: keep your existing `servers` entries and add
`celiums-memory` alongside them.

## After saving the file

Restart the host editor (or open its MCP panel and reconnect). Once
the shim's first invocation completes, you should see the Celiums
toolset loaded — `recall`, `remember`, `forage`, `journal_*`,
`research_*`, `write_*`, etc. — under the `celiums-memory` server.

## Troubleshooting

- **`API key rejected`** — the key in `CELIUMS_API_KEY` doesn't match
  the one the server expects. Re-copy it from the dashboard's Settings
  page; keys never contain whitespace.
- **`HTTP 403` from a Cloudflare error page** — the URL you set
  resolves to an IP Cloudflare has blocked. Confirm the URL points at
  your droplet (or to `memory.celiums.ai` / your tenant URL).
- **`tools/list` returns nothing** — check the host's MCP log; the
  shim prints a one-line error to stderr if `--url` or
  `CELIUMS_API_KEY` are missing.
- **`npx` not found** — install Node.js 18+ (`node --version`).
  The shim relies on `npx` to fetch and run `@celiums/mcp`.
