# Droplet packaging — Celiums Memory v1.2.6

Files used to build the DigitalOcean 1-Click Marketplace snapshot. Everything
in this directory is what *ships inside* the snapshot; nothing here is fetched
at boot time.

## Layout

```
packaging/droplet/
├── caddy/
│   └── Caddyfile                 → /etc/celiums/Caddyfile
├── cloud-init/
│   ├── firstboot.sh              → /opt/celiums-memory/.../firstboot.sh
│   └── user-data.yaml            → cloud-config baked into the snapshot
└── systemd/
    ├── celiums-engine.service    → /etc/systemd/system/celiums-engine.service
    ├── celiums-dashboard.service → /etc/systemd/system/celiums-dashboard.service
    ├── celiums-proxy.service     → /etc/systemd/system/celiums-proxy.service
    ├── celiums-tunnel.service    → /etc/systemd/system/celiums-tunnel.service
    └── celiums-firstboot.service → /etc/systemd/system/celiums-firstboot.service
```

## Topology

```
                      ┌──────────────────────────┐
                      │  *.trycloudflare.com     │  (public, TLS)
                      └────────────┬─────────────┘
                                   │
                                   ▼
                       cloudflared quick-tunnel
                                   │
                                   ▼
                          127.0.0.1:8080
                          ┌────────────────┐
                          │  Caddy (proxy) │
                          └───┬────────┬───┘
                              │        │
              /v1, /mcp,      │        │  everything else
              /oauth,         │        │
              /.well-known    │        │
                              ▼        ▼
                    127.0.0.1:3210  127.0.0.1:5173
                     ┌──────────┐    ┌──────────────┐
                     │  engine  │    │  dashboard   │
                     │  (Node)  │    │  (Node SSR)  │
                     └──────────┘    └──────────────┘
```

## Conventions

- **Code**: `/opt/celiums-memory` (clone of this repo, owned by `celiums:celiums`)
- **Config**: `/etc/celiums/` mode `0700`
  - `env` — runtime environment for engine + dashboard (mode `0600`)
  - `master.key` — AES-256-GCM master key for the BYOK keyvault (mode `0600`)
  - `keyvault.enc` — encrypted vault file (mode `0600`)
  - `Caddyfile` — reverse proxy config
- **Data**: `/var/lib/celiums/` mode `0700` owned by `celiums`
  - `auth.json` — admin user + sessions (scrypt-hashed)
- **Operator surface**: `/root/.celiums/` mode `0700`
  - `dashboard_url` — the `*.trycloudflare.com` URL minted on first boot
  - `api-key` — engine bearer token for MCP clients

## Service order

`celiums-firstboot` (oneshot) → `celiums-engine` → `celiums-dashboard` →
`celiums-proxy` → `celiums-tunnel`. Each unit declares the previous one in
`Requires=` so a restart of the lower layer cascades upward.

## Public ingress decision

We use **cloudflared quick-tunnel** as the public edge instead of Caddy with
Let's Encrypt because the 1-Click user has no DNS, no Cloudflare account,
and no firewall rules configured. Quick-tunnel mints a working `https://`
URL within seconds without touching any of that.

The trade-off is that quick-tunnel URLs are ephemeral — they change when
the tunnel daemon restarts. For users who want a stable URL we will ship
a follow-up "bring your own Cloudflare account" mode in v1.3.

Caddy is still required *internally* because cloudflared accepts only one
upstream URL per tunnel, and we have two services (dashboard + engine)
that need to share the same hostname under different paths.

## Local testing

```bash
# 1. Build the dashboard
pnpm --filter @celiums/dashboard build

# 2. Stage the layout (requires sudo)
sudo install -d -m 0700 -o $(id -u) /etc/celiums /var/lib/celiums
sudo cp packaging/droplet/caddy/Caddyfile /etc/celiums/

# 3. Start the engine + dashboard manually for a smoke run
ENGINE_KEY=test pnpm start &
PORT=5173 ENGINE_URL=http://127.0.0.1:3210 ENGINE_KEY=test \
  node packages/dashboard/build/index.js &

# 4. Start Caddy in the foreground
caddy run --config /etc/celiums/Caddyfile --adapter caddyfile

# 5. Verify
curl http://127.0.0.1:8080/health           # → engine /health
curl http://127.0.0.1:8080/                 # → dashboard
```

## Snapshot build (manual)

1. Spin a clean Ubuntu 22.04 droplet.
2. Install dependencies: `nodejs` (≥20), `pnpm`, `caddy`, `cloudflared`,
   `postgresql-17 + pgvector`, `valkey`.
3. `git clone https://github.com/terrizoaguimor/celiums-memory /opt/celiums-memory`
4. `useradd -r -s /usr/sbin/nologin -d /opt/celiums-memory celiums`
5. `chown -R celiums:celiums /opt/celiums-memory`
6. `cp packaging/droplet/systemd/*.service /etc/systemd/system/`
7. `systemctl daemon-reload` (do **not** enable any unit yet)
8. Snapshot the droplet via `doctl compute droplet-action snapshot ...`.

The resulting snapshot is published to the DO Marketplace as v1.2.6. On
deploy, `cloud-init/user-data.yaml` enables `celiums-firstboot.service`
which runs `firstboot.sh` to provision the per-droplet secrets and start
the runtime services.
