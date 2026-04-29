#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Celiums Memory — single-shot installer for Ubuntu 22.04 / 24.04.
#
# Usage (as root):
#
#   curl -fsSL https://raw.githubusercontent.com/terrizoaguimor/celiums-memory/main/packaging/setup.sh \
#     | bash
#
# Provisions the FULL triple-storage stack:
#
#   • Postgres 17 + pgvector          (memory + knowledge stores)
#   • Valkey / Redis 7                 (working set + circadian state)
#   • Qdrant 1.14                      (memory embeddings)
#   • Caddy 2                          (reverse proxy + auto-TLS)
#   • Node 20 + pnpm 9                 (runtime)
#
# Then:
#   • clones the repo to /opt/celiums-memory
#   • builds @celiums/memory + dashboard
#   • creates DBs, applies schemas, hydrates the 5,100 starter modules
#   • generates per-droplet secrets in /etc/celiums/env
#   • installs systemd units (engine + dashboard + proxy)
#   • leaves the proxy stopped — `celiums-setup` arms it after the user
#     picks an access mode (FQDN with Let's Encrypt or IP self-signed)
#
# Total runtime: ~6–10 min on a 2vcpu/4gb droplet, mostly apt + pnpm.
# Idempotent — re-runs are safe, each phase checks before doing work.
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail
LOG=/var/log/celiums-install.log
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

# ── Constants ────────────────────────────────────────────────────────
CELIUMS_HOME=/opt/celiums-memory
ETC_DIR=/etc/celiums
DATA_DIR=/var/lib/celiums
ROOT_OUT=/root/.celiums
REPO_URL=${CELIUMS_REPO_URL:-https://github.com/terrizoaguimor/celiums-memory.git}
REPO_REF=${CELIUMS_REPO_REF:-main}
PG_VERSION=17
# Pin Qdrant to a release whose binary is compatible with the GLIBC
# shipped on Ubuntu 22.04 (2.35). 1.13+ require GLIBC 2.38 and crash
# at start with `libc.so.6: version 'GLIBC_2.38' not found`.
QDRANT_VERSION=1.12.6
QDRANT_USER=qdrant
QDRANT_HOME=/var/lib/qdrant

# ── Helpers ──────────────────────────────────────────────────────────
green() { printf '\033[32m%s\033[0m\n' "$*"; }
cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

phase() {
  echo
  cyan "════════════════════════════════════════════════════════════════"
  cyan "  $*"
  cyan "════════════════════════════════════════════════════════════════"
}

require_root() {
  if [[ $(id -u) -ne 0 ]]; then
    red "This installer must run as root."
    exit 1
  fi
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" "$@" >/dev/null
}

# ── Phase 1: base packages ───────────────────────────────────────────
phase "[1/12] Base packages"
require_root
apt-get update -qq
apt_install ca-certificates curl gnupg lsb-release \
  build-essential git openssl dnsutils \
  apt-transport-https debian-keyring debian-archive-keyring jq
green "✓ base"

# ── Phase 2: Node 20 + pnpm via corepack ─────────────────────────────
phase "[2/12] Node 20 + pnpm"
if ! command -v node >/dev/null || ! node -v | grep -q "^v20"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt_install nodejs
fi
corepack enable
corepack prepare pnpm@9.4.0 --activate
green "✓ node $(node -v)  pnpm $(pnpm -v)"

# ── Phase 3: Postgres 17 + pgvector via PGDG ─────────────────────────
phase "[3/12] PostgreSQL ${PG_VERSION} + pgvector"
if ! command -v psql >/dev/null || ! psql --version | grep -q " ${PG_VERSION}"; then
  apt_install postgresql-common
  printf 'YES\n' | sh /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y >/dev/null 2>&1 || true
  apt-get update -qq
  apt_install postgresql-${PG_VERSION} "postgresql-${PG_VERSION}-pgvector"
fi
systemctl enable --now postgresql
green "✓ postgres $(psql --version | awk '{print $3}')"

# ── Phase 4: Valkey / Redis 7 ────────────────────────────────────────
phase "[4/12] Valkey (redis-server compatible)"
apt_install redis-server
# Bind only to localhost + require password.
VALKEY_PASS_FILE=$DATA_DIR/.valkey-pass
mkdir -p "$DATA_DIR"
if [[ ! -f $VALKEY_PASS_FILE ]]; then
  openssl rand -hex 32 > "$VALKEY_PASS_FILE"
  chmod 0600 "$VALKEY_PASS_FILE"
fi
VALKEY_PASS=$(cat "$VALKEY_PASS_FILE")
if ! grep -q "^requirepass $VALKEY_PASS" /etc/redis/redis.conf 2>/dev/null; then
  sed -i 's|^# requirepass .*$|# requirepass replaced-by-celiums|' /etc/redis/redis.conf
  sed -i '/^requirepass /d' /etc/redis/redis.conf
  echo "requirepass $VALKEY_PASS" >> /etc/redis/redis.conf
  sed -i 's|^bind .*$|bind 127.0.0.1 ::1|' /etc/redis/redis.conf
fi
systemctl enable --now redis-server
systemctl restart redis-server
green "✓ redis/valkey on 127.0.0.1:6379 (auth)"

# ── Phase 5: Qdrant ──────────────────────────────────────────────────
phase "[5/12] Qdrant ${QDRANT_VERSION}"
if ! command -v qdrant >/dev/null; then
  TMP=$(mktemp -d)
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  QARCH="x86_64-unknown-linux-gnu" ;;
    aarch64) QARCH="aarch64-unknown-linux-gnu" ;;
    *) red "unsupported arch $ARCH"; exit 1 ;;
  esac
  curl -fsSL "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-${QARCH}.tar.gz" \
    -o "$TMP/qdrant.tar.gz"
  tar -xzf "$TMP/qdrant.tar.gz" -C "$TMP"
  install -m 0755 "$TMP/qdrant" /usr/local/bin/qdrant
  rm -rf "$TMP"
fi
id -u "$QDRANT_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$QDRANT_HOME" "$QDRANT_USER"
mkdir -p "$QDRANT_HOME"/{storage,snapshots} /etc/qdrant
chown -R "$QDRANT_USER:$QDRANT_USER" "$QDRANT_HOME"
cat > /etc/qdrant/production.yaml <<'YAML'
service:
  host: 127.0.0.1
  http_port: 6333
  grpc_port: 6334
storage:
  storage_path: /var/lib/qdrant/storage
  snapshots_path: /var/lib/qdrant/snapshots
log_level: INFO
YAML
cat > /etc/systemd/system/qdrant.service <<'UNIT'
[Unit]
Description=Qdrant vector store
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=qdrant
Group=qdrant
WorkingDirectory=/var/lib/qdrant
ExecStart=/usr/local/bin/qdrant --config-path /etc/qdrant/production.yaml
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=qdrant

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qdrant
green "✓ qdrant on 127.0.0.1:6333"

# ── Phase 6: Caddy 2 ─────────────────────────────────────────────────
phase "[6/12] Caddy 2"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt_install caddy
fi
# We run Caddy under our own systemd unit, not the apt one.
systemctl disable --now caddy.service 2>/dev/null || true
green "✓ caddy $(caddy version | head -1)"

# ── Phase 7: celiums system user + repo ──────────────────────────────
phase "[7/12] celiums user + clone"
id -u celiums >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$CELIUMS_HOME" celiums
# After the first run /opt/celiums-memory is owned by celiums; root running
# git in there trips git's "dubious ownership" safety check. Whitelist it
# globally so re-runs succeed.
git config --system --add safe.directory "$CELIUMS_HOME" 2>/dev/null || true
if [[ ! -d $CELIUMS_HOME/.git ]]; then
  rm -rf "$CELIUMS_HOME"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$CELIUMS_HOME"
else
  git -C "$CELIUMS_HOME" fetch --quiet
  git -C "$CELIUMS_HOME" reset --hard "origin/$REPO_REF" --quiet
fi
chown -R celiums:celiums "$CELIUMS_HOME"
mkdir -p "$ETC_DIR" "$DATA_DIR" "$ROOT_OUT"
chown celiums:celiums "$ETC_DIR" "$DATA_DIR"
chmod 0700 "$ETC_DIR" "$DATA_DIR" "$ROOT_OUT"
green "✓ /opt/celiums-memory @ $(git -C "$CELIUMS_HOME" rev-parse --short HEAD)"

# ── Phase 8: pnpm install + build ────────────────────────────────────
phase "[8/12] Install + build packages"
sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm install --frozen-lockfile --silent"
sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm --filter @celiums/memory build"
sudo -u celiums bash -c "cd $CELIUMS_HOME && pnpm --filter @celiums/dashboard build"
green "✓ engine + dashboard built"

# ── Phase 9: Postgres DBs + schema ───────────────────────────────────
phase "[9/12] Databases + schemas"
PG_PASS_FILE=$DATA_DIR/.pg-pass
if [[ ! -f $PG_PASS_FILE ]]; then
  openssl rand -hex 32 > "$PG_PASS_FILE"
  chmod 0600 "$PG_PASS_FILE"
fi
PG_PASS=$(cat "$PG_PASS_FILE")

# Create role + databases (idempotent).
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='celiums'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE celiums LOGIN PASSWORD '${PG_PASS}'"
sudo -u postgres psql -c "ALTER ROLE celiums PASSWORD '${PG_PASS}'" >/dev/null

for DB in celiums_memory celiums_knowledge; do
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
    || sudo -u postgres createdb -O celiums "$DB"
done
sudo -u postgres psql -d celiums_memory   -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" >/dev/null
sudo -u postgres psql -d celiums_knowledge -c "CREATE EXTENSION IF NOT EXISTS vector"   >/dev/null

# Apply the memory schema as the celiums role so the resulting tables
# are owned by it. Otherwise the engine fails at boot with "must be
# owner of table user_profiles".
PGURL_MEM="postgresql://celiums:${PG_PASS}@127.0.0.1:5432/celiums_memory"
if [[ -f $CELIUMS_HOME/scripts/schema.sql ]]; then
  PGPASSWORD="$PG_PASS" psql -X "$PGURL_MEM" -f "$CELIUMS_HOME/scripts/schema.sql" >/dev/null 2>&1 || true
fi
for m in $CELIUMS_HOME/scripts/migrations/*.sql; do
  [[ -f $m ]] || continue
  PGPASSWORD="$PG_PASS" psql -X "$PGURL_MEM" -f "$m" >/dev/null 2>&1 || true
done
# Belt-and-suspenders: re-assign anything left under the postgres role.
sudo -u postgres psql -d celiums_memory   -c "REASSIGN OWNED BY postgres TO celiums" >/dev/null 2>&1 || true
sudo -u postgres psql -d celiums_knowledge -c "REASSIGN OWNED BY postgres TO celiums" >/dev/null 2>&1 || true
green "✓ celiums_memory + celiums_knowledge ready"

# ── Phase 10: hydrate 5,100 starter modules ──────────────────────────
phase "[10/12] Hydrate starter modules"
KNOWLEDGE_URL="postgres://celiums:${PG_PASS}@127.0.0.1:5432/celiums_knowledge"
# Write the hydrate script inside packages/knowledge — that's the
# workspace that lists `pg` as a direct dependency, so its
# node_modules has the symlink. The repo root's node_modules has
# only top-level deps, not workspace transitive ones.
HYDRATE_SCRIPT=$CELIUMS_HOME/packages/knowledge/.celiums-hydrate.mjs
cat > "$HYDRATE_SCRIPT" <<'NODE'
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import pg from 'pg';

const SEED = process.env.SEED_PATH;
const url  = process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: url });

await pool.query(`CREATE TABLE IF NOT EXISTS modules (
  name         TEXT PRIMARY KEY,
  display_name TEXT,
  description  TEXT,
  category     TEXT,
  keywords     TEXT[],
  line_count   INT,
  eval_score   DOUBLE PRECISION,
  version      TEXT,
  content      TEXT,
  embedding    vector(384),
  fts          tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name,'')),         'A') ||
    setweight(to_tsvector('english', coalesce(display_name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')),  'B') ||
    setweight(to_tsvector('english', coalesce(content,'')),      'C')
  ) STORED
)`);
await pool.query(`CREATE INDEX IF NOT EXISTS modules_fts_gin ON modules USING gin(fts)`);
await pool.query(`CREATE INDEX IF NOT EXISTS modules_category_idx ON modules(category)`);

const rl = createInterface({
  input: createReadStream(SEED).pipe(createGunzip()),
  crlfDelay: Infinity,
});

let inserted = 0, batch = [];
const FLUSH_AT = 100;

async function flush() {
  if (batch.length === 0) return;
  const cols = ['name','display_name','description','category','keywords','line_count','eval_score','version','content'];
  const placeholders = batch.map((_, i) => {
    const o = i * cols.length;
    return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9})`;
  }).join(',');
  const values = batch.flatMap((m) => [
    m.name, m.displayName ?? null, m.description ?? null, m.category ?? null,
    m.keywords ?? [], m.lineCount ?? 0, m.evalScore ?? null,
    m.version ?? '1.0', m.content ?? '',
  ]);
  await pool.query(
    `INSERT INTO modules (${cols.join(',')}) VALUES ${placeholders}
       ON CONFLICT (name) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description  = EXCLUDED.description,
         category     = EXCLUDED.category,
         keywords     = EXCLUDED.keywords,
         line_count   = EXCLUDED.line_count,
         eval_score   = EXCLUDED.eval_score,
         version      = EXCLUDED.version,
         content      = EXCLUDED.content`,
    values
  );
  inserted += batch.length;
  batch = [];
  if (inserted % 500 === 0) console.log('  ' + inserted + ' rows…');
}

for await (const line of rl) {
  if (!line.trim()) continue;
  batch.push(JSON.parse(line));
  if (batch.length >= FLUSH_AT) await flush();
}
await flush();

const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM modules');
console.log('  total in DB: ' + rows[0].n);
await pool.end();
NODE

chown celiums:celiums "$HYDRATE_SCRIPT"
chmod 0644 "$HYDRATE_SCRIPT"
sudo -u celiums env \
  "DATABASE_URL=$KNOWLEDGE_URL" \
  "SEED_PATH=$CELIUMS_HOME/packages/modules-starter/data/seed.jsonl.gz" \
  node "$HYDRATE_SCRIPT" 2>&1 | sed 's/^/  /'
rm -f "$HYDRATE_SCRIPT"
green "✓ modules hydrated"

# ── Phase 11: secrets + /etc/celiums/env ─────────────────────────────
phase "[11/12] Generate secrets + env"
if [[ ! -f $ETC_DIR/master.key ]]; then
  openssl rand -base64 32 | base64 -d > "$ETC_DIR/master.key"
fi
chown celiums:celiums "$ETC_DIR/master.key"
chmod 0600 "$ETC_DIR/master.key"

ENGINE_KEY="cmk_$(openssl rand -base64 32 | tr -d '+/=' | cut -c1-43)"

cat > "$ETC_DIR/env" <<ENV
# Celiums Memory runtime — generated $(date -u +'%Y-%m-%dT%H:%M:%SZ')
NODE_ENV=production

# ── Storage ──
DATABASE_URL=postgres://celiums:${PG_PASS}@127.0.0.1:5432/celiums_memory
KNOWLEDGE_DATABASE_URL=postgres://celiums:${PG_PASS}@127.0.0.1:5432/celiums_knowledge
QDRANT_URL=http://127.0.0.1:6333
VALKEY_URL=redis://:${VALKEY_PASS}@127.0.0.1:6379

# ── Engine ──
HOST=127.0.0.1

# ── Dashboard ──
ORIGIN=http://127.0.0.1:5173
ENGINE_URL=http://127.0.0.1:3210
ENGINE_KEY=${ENGINE_KEY}

# ── BYOK keyvault (AES-256-GCM) ──
CELIUMS_MASTER_KEY_PATH=${ETC_DIR}/master.key
CELIUMS_VAULT_PATH=${ETC_DIR}/keyvault.enc
CELIUMS_AUTH_FILE=${DATA_DIR}/auth.json
ENV
chown celiums:celiums "$ETC_DIR/env"
chmod 0600 "$ETC_DIR/env"

echo "$ENGINE_KEY" > "$ROOT_OUT/api-key"
chmod 0600 "$ROOT_OUT/api-key"
green "✓ /etc/celiums/env"

# ── Phase 12: systemd units + start engine + dashboard ───────────────
phase "[12/12] systemd units"
install -m 0644 "$CELIUMS_HOME/packaging/droplet/systemd/celiums-engine.service"      /etc/systemd/system/
install -m 0644 "$CELIUMS_HOME/packaging/droplet/systemd/celiums-dashboard.service"   /etc/systemd/system/
install -m 0644 "$CELIUMS_HOME/packaging/droplet/systemd/celiums-proxy.service"       /etc/systemd/system/

# Grant Caddy the bind-service capability (it runs as the celiums user).
setcap "cap_net_bind_service=+ep" "$(command -v caddy)"
mkdir -p /var/lib/caddy
chown celiums:celiums /var/lib/caddy

# celiums-setup CLI on PATH for the FQDN/IP wizard (run by the user).
install -m 0755 "$CELIUMS_HOME/packaging/droplet/scripts/celiums-setup.mjs" /usr/local/bin/celiums-setup

systemctl daemon-reload
systemctl enable --now celiums-engine.service
systemctl enable --now celiums-dashboard.service

# Proxy stays installed but disabled — celiums-setup arms it once the
# user picks FQDN or IP mode.
systemctl disable celiums-proxy.service 2>/dev/null || true

# MOTD: tell the user what to do next.
cat > /etc/update-motd.d/99-celiums <<'MOTD'
#!/usr/bin/env bash
echo ""
echo "  ╭───────────────────────────────────────────────────────────────╮"
echo "  │  Celiums Memory                                                │"
echo "  ╰───────────────────────────────────────────────────────────────╯"
if [[ -f /etc/celiums/setup.json ]] && grep -q '"completed": true' /etc/celiums/setup.json 2>/dev/null; then
  [[ -f /root/.celiums/dashboard_url ]] && echo "  Dashboard : $(cat /root/.celiums/dashboard_url)"
  [[ -f /root/.celiums/api-key ]]       && echo "  API key   : $(cat /root/.celiums/api-key)"
  echo ""
  echo "  Reconfigure : sudo celiums-setup"
else
  echo ""
  echo "  Engine + dashboard are running on localhost. Pick how the"
  echo "  dashboard is exposed publicly:"
  echo ""
  echo "      sudo celiums-setup"
  echo ""
  echo "  Choose between FQDN (Let's Encrypt) or HTTPS-by-IP (self-signed)."
fi
echo ""
echo "  Logs   : journalctl -u celiums-engine -u celiums-dashboard -u celiums-proxy"
echo "  Config : /etc/celiums/env  (mode 0600, owner celiums)"
echo "  Docs   : https://github.com/terrizoaguimor/celiums-memory"
echo ""
MOTD
chmod 0755 /etc/update-motd.d/99-celiums
green "✓ systemd active"

# ── Summary ──────────────────────────────────────────────────────────
phase "Install complete"
echo
green "Engine     : http://127.0.0.1:3210      ($(systemctl is-active celiums-engine.service))"
green "Dashboard  : http://127.0.0.1:5173      ($(systemctl is-active celiums-dashboard.service))"
green "Postgres   : 127.0.0.1:5432            ($(systemctl is-active postgresql))"
green "Valkey     : 127.0.0.1:6379 (auth)     ($(systemctl is-active redis-server))"
green "Qdrant     : 127.0.0.1:6333            ($(systemctl is-active qdrant))"
echo
cyan "Next step — choose how the dashboard is exposed:"
echo
echo "    sudo celiums-setup"
echo
echo "Logs : tail -f $LOG"
