#!/bin/bash
###############################################
# Celiums Memory — One-Command Setup
#
# Usage:
#   curl -fsSL https://celiums.ai/install.sh | bash
#   OR
#   git clone ... && cd celiums-memory && bash setup.sh
#
# Result:
#   - Engine running on :3210 (internal)
#   - Dashboard on :8080 (internal)
#   - Public URL via Cloudflare tunnel
#   - Open browser → create admin account → done
###############################################

set -e

GREEN='\033[0;32m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo -e "  ${GREEN}●${NC} Celiums Memory — Setup"
echo -e "  ${DIM}Neuroscience-grounded AI memory with emotions${NC}"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version &> /dev/null; then
  echo "Error: docker compose not found. Install Docker Desktop or Docker Engine."
  exit 1
fi

# Generate API key if not set
if [ -z "$API_KEY" ]; then
  API_KEY="cmk_$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 40)"
  echo "API_KEY=$API_KEY" > .env
  echo -e "  Generated API key: ${GREEN}${API_KEY:0:12}...${NC}"
fi

# Clone engine if not present
if [ ! -d "engine" ]; then
  echo "  Cloning celiums-memory engine..."
  git clone --depth 1 https://github.com/terrizoaguimor/celiums-memory.git engine 2>/dev/null
  echo "  Engine ready."
fi

# Build dashboard if not present
if [ ! -d "dashboard/build" ]; then
  echo "  Dashboard build not found. Building..."
  cd dashboard 2>/dev/null || (
    echo "  Error: dashboard/ directory not found."
    echo "  Place the celiums-ui build in ./dashboard/"
    exit 1
  )
  npm install --omit=dev 2>/dev/null
  cd ..
fi

# Start everything
echo ""
echo "  Starting services..."
docker compose up -d 2>&1 | grep -E "Started|Created|Running" | head -10

# Wait for tunnel to generate URL
echo ""
echo -e "  ${DIM}Waiting for public URL...${NC}"
sleep 8

# Get tunnel URL from logs
TUNNEL_URL=$(docker logs celiums-tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)

echo ""
echo "  ══════════════════════════════════════════════"
echo ""
echo -e "  ${GREEN}●${NC} Celiums Memory is running!"
echo ""

if [ -n "$TUNNEL_URL" ]; then
  echo -e "  Public URL:  ${GREEN}${TUNNEL_URL}${NC}"
  echo "  Dashboard:   ${TUNNEL_URL}"
  echo ""

  # Update ORIGIN for CSRF protection
  docker compose stop dashboard 2>/dev/null
  ORIGIN="$TUNNEL_URL" docker compose up -d dashboard 2>/dev/null
fi

echo "  Local:       http://localhost:8080"
echo "  Engine API:  http://localhost:3210 (internal)"
echo ""
echo -e "  API Key:     ${GREEN}${API_KEY:0:12}...${NC}"
echo ""
echo "  ──────────────────────────────────────────────"
echo ""
echo "  Next: Open the URL above and create your admin account."
echo "  Then connect Claude Code, ChatGPT, or any AI agent."
echo ""
echo -e "  ${DIM}Docs: https://celiums.ai | GitHub: terrizoaguimor/celiums-memory${NC}"
echo ""
