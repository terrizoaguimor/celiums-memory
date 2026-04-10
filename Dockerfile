# ─────────────────────────────────────────────
#  celiums-memory — Production Dockerfile
#
#  Single-stage Node.js image that runs the quickstart server.
#  Auto-detects storage mode from environment variables:
#    - DATABASE_URL + QDRANT_URL + VALKEY_URL → triple-store (production)
#    - SQLITE_PATH                            → sqlite (single-file)
#    - (none)                                  → in-memory (volatile)
#
#  Schema migration is automatic on first boot via MemoryStore.initialize().
# ─────────────────────────────────────────────
FROM node:22-alpine AS base

RUN apk add --no-cache curl tini python3 make g++ libc6-compat

WORKDIR /app

# ─────────────────────────────────────────────
#  Dependencies
# ─────────────────────────────────────────────
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/core/package.json ./packages/core/

RUN npm install -g pnpm@9 tsx
RUN pnpm install --no-frozen-lockfile

# ─────────────────────────────────────────────
#  Source
# ─────────────────────────────────────────────
COPY packages/types ./packages/types
COPY packages/core ./packages/core
COPY scripts ./scripts

# Build types package (core uses workspace dep)
RUN cd packages/types && pnpm build

# ─────────────────────────────────────────────
#  Runtime config
# ─────────────────────────────────────────────
ENV NODE_ENV=production \
    PORT=3210 \
    HOST=0.0.0.0 \
    PERSONALITY=balanced

EXPOSE 3210

# Healthcheck — respects the auto-detected mode
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fs http://localhost:3210/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["tsx", "packages/core/src/quickstart.ts"]
