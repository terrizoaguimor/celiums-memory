#!/usr/bin/env bash
# Celiums Memory — first-boot provisioning script.
#
# Runs ONCE on first boot of a 1-Click droplet built from the v1.2.6
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
# All three runtime services run as the celiums user, so the config
# directory must be owned by celiums (mode 0700 keeps it private to
# that user). /var/lib/celiums holds auth.json, same story.
chown celiums:celiums "$ETC_DIR" "$DATA_DIR"
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

# Engine + dashboard share the same env file; the per-service systemd
# units override PORT so the two listeners don't collide on 3210/5173.
HOST=127.0.0.1
ORIGIN=http://127.0.0.1:5173
ENGINE_URL=http://127.0.0.1:3210
ENGINE_KEY=${ENGINE_KEY}

# BYOK keyvault (AES-256-GCM)
CELIUMS_MASTER_KEY_PATH=${ETC_DIR}/master.key
CELIUMS_VAULT_PATH=${ETC_DIR}/keyvault.enc
CELIUMS_AUTH_FILE=${DATA_DIR}/auth.json

# SQLite knowledge store — gives the engine the 5,100 starter modules
# from @celiums/modules-starter on first launch. Without this the
# engine runs in pure in-memory mode and /modules is empty.
SQLITE_PATH=${DATA_DIR}/celiums.db

# ─────────────────────────────────────────────────────────────────────
# Optional persistence layer.
#
# By default the engine runs in **in-memory mode** — perfect for
# evaluating the product, no extra services to install. Memories
# are wiped on engine restart.
#
# For persistent storage, install Postgres 17 + pgvector and Valkey,
# then uncomment the two URLs below. The credentials were generated
# fresh for this droplet:
#   PG_PASSWORD=${PG_PASSWORD}
#   VALKEY_PASSWORD=${VALKEY_PASSWORD}
# ─────────────────────────────────────────────────────────────────────
# DATABASE_URL=postgres://celiums:${PG_PASSWORD}@127.0.0.1:5432/celiums
# REDIS_URL=redis://:${VALKEY_PASSWORD}@127.0.0.1:6379
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
  echo "==> Installing workspace dependencies"
  sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm install --frozen-lockfile"
  # @celiums/memory (packages/core) has to be built first because the
  # dashboard imports from its compiled dist/. Without this, vite build
  # fails with ERR_MODULE_NOT_FOUND on @celiums/memory/dist/index.js.
  echo "==> Building @celiums/memory (engine SDK)"
  sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm --filter @celiums/memory build"
  # Building modules-starter is best-effort — the engine's dynamic
  # import falls back gracefully if it's missing.
  echo "==> Building @celiums/modules-starter (5,100 seed modules)"
  sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm --filter @celiums/modules-starter build" || true
  echo "==> Building dashboard (adapter-node)"
  sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm --filter @celiums/dashboard build"
else
  echo "==> Dashboard build already present"
fi

# ---------------------------------------------------------------------------
# 4. Enable + start services in dependency order.
# ---------------------------------------------------------------------------
echo "==> Enabling internal services"
systemctl daemon-reload
systemctl enable --now celiums-engine.service
systemctl enable --now celiums-dashboard.service
# celiums-proxy intentionally NOT started here — it has no Caddyfile yet.
# The user runs `sudo celiums-setup` over SSH to choose FQDN vs IP mode,
# which writes /etc/celiums/Caddyfile and starts the proxy.

# Legacy: install but do NOT enable celiums-tunnel / celiums-redirect.
# They remain available for users who explicitly want quick-tunnel mode
# (`systemctl enable --now celiums-tunnel celiums-redirect`).

# ---------------------------------------------------------------------------
# 5. Stage the celiums-setup binary on PATH so first SSH login can run it.
# ---------------------------------------------------------------------------
install -m 0755 \
  "$CELIUMS_HOME/packaging/droplet/scripts/celiums-setup.mjs" \
  /usr/local/bin/celiums-setup

# Capture the engine API key so MCP clients can be configured later.
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
if [ -f /etc/celiums/setup.json ] && grep -q '"completed": true' /etc/celiums/setup.json 2>/dev/null; then
  if [ -f /root/.celiums/dashboard_url ]; then
    echo "  Dashboard : $(cat /root/.celiums/dashboard_url)"
  fi
  if [ -f /root/.celiums/api-key ]; then
    echo "  API key   : $(cat /root/.celiums/api-key)"
  fi
  echo ""
  echo "  Reconfigure : sudo celiums-setup"
else
  echo ""
  echo "  Setup is not complete yet. Run:"
  echo ""
  echo "      sudo celiums-setup"
  echo ""
  echo "  to choose how the dashboard is exposed (FQDN with Let's"
  echo "  Encrypt, or HTTPS-by-IP with a self-signed cert)."
fi
echo ""
echo "  Logs   : journalctl -u celiums-engine -u celiums-dashboard -u celiums-proxy"
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
