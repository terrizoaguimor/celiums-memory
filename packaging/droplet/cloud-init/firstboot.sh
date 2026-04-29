#!/usr/bin/env bash
# Celiums Memory — first-boot provisioning script.
#
# Runs ONCE on first boot of a 1-Click droplet built from the v1.2.5
# snapshot. The snapshot ships with code at /opt/celiums-memory and
# all systemd units installed but disabled. This script:
#
#   1. Generates fresh secrets (master encryption key, internal engine
#      key, Postgres + Valkey passwords) into /etc/celiums/env.
#   2. Builds the dashboard for production (adapter-node).
#   3. Enables and starts the four services in dependency order:
#        engine → dashboard → proxy → tunnel
#   4. Waits for cloudflared to mint a *.trycloudflare.com URL and
#      writes it to /root/.celiums/dashboard_url for the operator.
#
# Triggered by /etc/systemd/system/celiums-firstboot.service which
# runs `Type=oneshot` and removes itself on success.

set -euo pipefail

LOG=/var/log/celiums-firstboot.log
exec > >(tee -a "$LOG") 2>&1

echo "==> Celiums first-boot @ $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

CELIUMS_HOME=/opt/celiums-memory
ETC_DIR=/etc/celiums
DATA_DIR=/var/lib/celiums
ROOT_OUT=/root/.celiums

mkdir -p "$ETC_DIR" "$DATA_DIR" "$ROOT_OUT"
chown celiums:celiums "$DATA_DIR"
chmod 0700 "$ETC_DIR" "$DATA_DIR"
chmod 0700 "$ROOT_OUT"

# ---------------------------------------------------------------------------
# 1. Secrets — generated fresh per droplet, never baked into the snapshot.
# ---------------------------------------------------------------------------
gen_b64() { openssl rand -base64 32 | tr -d '\n'; }
gen_hex() { openssl rand -hex 32; }

if [ ! -f "$ETC_DIR/env" ]; then
  echo "==> Generating secrets"
  MASTER_KEY_B64=$(gen_b64)
  ENGINE_KEY="cmk_$(openssl rand -base64 32 | tr -d '+/=' | cut -c1-43)"
  PG_PASSWORD=$(gen_hex)
  VALKEY_PASSWORD=$(gen_hex)

  # Master key for the BYOK keyvault (AES-256-GCM). The dashboard reads
  # this via CELIUMS_MASTER_KEY (base64). We also write the raw bytes
  # to /etc/celiums/master.key for older code paths that read the file.
  echo -n "$MASTER_KEY_B64" | base64 -d > "$ETC_DIR/master.key"
  chown celiums:celiums "$ETC_DIR/master.key"
  chmod 0600 "$ETC_DIR/master.key"

  cat > "$ETC_DIR/env" <<ENV
# Celiums Memory runtime environment — generated $(date -u +'%Y-%m-%dT%H:%M:%SZ')
NODE_ENV=production

# Engine
CELIUMS_PORT=3210
CELIUMS_HOST=127.0.0.1
DATABASE_URL=postgres://celiums:${PG_PASSWORD}@127.0.0.1:5432/celiums
REDIS_URL=redis://:${VALKEY_PASSWORD}@127.0.0.1:6379

# Dashboard
PORT=5173
HOST=127.0.0.1
ORIGIN=http://127.0.0.1:5173
ENGINE_URL=http://127.0.0.1:3210
ENGINE_KEY=${ENGINE_KEY}

# BYOK keyvault (AES-256-GCM)
CELIUMS_MASTER_KEY_PATH=${ETC_DIR}/master.key
CELIUMS_VAULT_PATH=${ETC_DIR}/keyvault.enc
CELIUMS_AUTH_FILE=${DATA_DIR}/auth.json
ENV

  chown celiums:celiums "$ETC_DIR/env"
  chmod 0600 "$ETC_DIR/env"
else
  echo "==> /etc/celiums/env already exists, skipping secret generation"
  # shellcheck disable=SC1091
  . "$ETC_DIR/env"
fi

# ---------------------------------------------------------------------------
# 2. Caddyfile — copy from repo into /etc/celiums (snapshot ships it but
#    we re-copy in case the operator modified the repo).
# ---------------------------------------------------------------------------
install -o celiums -g celiums -m 0644 \
  "$CELIUMS_HOME/packaging/droplet/caddy/Caddyfile" \
  "$ETC_DIR/Caddyfile"

# ---------------------------------------------------------------------------
# 3. Build dashboard for production. Skipped if build/ already exists,
#    which is the expected case for a clean snapshot.
# ---------------------------------------------------------------------------
if [ ! -f "$CELIUMS_HOME/packages/dashboard/build/index.js" ]; then
  echo "==> Building dashboard (adapter-node)"
  sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm install --frozen-lockfile && pnpm --filter @celiums/dashboard build"
else
  echo "==> Dashboard build already present"
fi

# ---------------------------------------------------------------------------
# 4. Enable + start services in dependency order.
# ---------------------------------------------------------------------------
echo "==> Enabling services"
systemctl daemon-reload
systemctl enable --now celiums-engine.service
systemctl enable --now celiums-dashboard.service
systemctl enable --now celiums-proxy.service
systemctl enable --now celiums-tunnel.service

# ---------------------------------------------------------------------------
# 5. Wait for cloudflared to mint a public URL (up to 90s) and persist it.
# ---------------------------------------------------------------------------
echo "==> Waiting for tunnel URL"
TUNNEL_URL=""
for i in $(seq 1 45); do
  TUNNEL_URL=$(journalctl -u celiums-tunnel.service --since "5 minutes ago" --no-pager -o cat 2>/dev/null \
    | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | tail -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 2
done

if [ -n "$TUNNEL_URL" ]; then
  echo "$TUNNEL_URL" > "$ROOT_OUT/dashboard_url"
  chmod 0600 "$ROOT_OUT/dashboard_url"
  echo "==> Public URL: $TUNNEL_URL"
else
  echo "!!! Tunnel URL not detected after 90s. Check: journalctl -u celiums-tunnel.service"
fi

# Also surface the engine API key so MCP clients can be configured.
ENGINE_KEY_VAL=$(grep '^ENGINE_KEY=' "$ETC_DIR/env" | cut -d= -f2-)
echo "$ENGINE_KEY_VAL" > "$ROOT_OUT/api-key"
chmod 0600 "$ROOT_OUT/api-key"

# ---------------------------------------------------------------------------
# 6. Print a friendly MOTD-style summary on first SSH login.
# ---------------------------------------------------------------------------
cat > /etc/update-motd.d/99-celiums <<'MOTD'
#!/usr/bin/env bash
echo ""
echo "  ╭─────────────────────────────────────────────────────────────╮"
echo "  │  Celiums Memory — your AI's persistent brain                │"
echo "  ╰─────────────────────────────────────────────────────────────╯"
if [ -f /root/.celiums/dashboard_url ]; then
  echo "  Dashboard : $(cat /root/.celiums/dashboard_url)"
fi
if [ -f /root/.celiums/api-key ]; then
  echo "  API key   : $(cat /root/.celiums/api-key)"
fi
echo ""
echo "  Logs   : journalctl -u celiums-engine -u celiums-dashboard -u celiums-tunnel"
echo "  Config : /etc/celiums/env  (mode 0600, owner celiums)"
echo "  Docs   : https://github.com/terrizoaguimor/celiums-memory"
echo ""
MOTD
chmod 0755 /etc/update-motd.d/99-celiums

echo "==> First-boot complete @ $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# Disarm the firstboot unit so it never runs again.
systemctl disable celiums-firstboot.service || true
rm -f /etc/systemd/system/celiums-firstboot.service
systemctl daemon-reload
