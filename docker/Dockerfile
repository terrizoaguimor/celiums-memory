# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Celiums Solutions LLC
#
# Celiums Memory — container image (used by docker/docker-compose.yml).
# Multi-stage; final runtime is Node 22 alpine, non-root.
#
# Builds packages/core (the deployable engine) + packages/types (its
# workspace dep). Entry: packages/core/dist/quickstart.js — the HTTP
# MCP server on :3210. Other workspace packages are peers, not built
# here. The knowledge corpus is bring-your-own, not bundled.

############################
# Stage 1 — deps + build
############################
FROM node:22-alpine AS builder

# Build-time deps for native modules (better-sqlite3 needs python + make)
RUN apk add --no-cache python3 make g++ libc6-compat

# pnpm via corepack (matches packageManager: pnpm@9.4.0 in package.json)
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

WORKDIR /build

# Copy lockfile + workspace config first for max cache reuse
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy the workspace packages. core (the app) + types (core dep) are the
# build targets; the other packages are peers in the workspace.
COPY packages/ ./packages/
COPY scripts/ ./scripts/
COPY schemas/ ./schemas/
COPY tsconfig.base.json* ./

# Install with devDeps (tsup, typescript) so we can build.
RUN pnpm install --frozen-lockfile

# Build packages/core only — that's the deployable.
RUN pnpm --filter @celiums/memory build

############################
# Stage 2 — prune to runtime deps
############################
FROM node:22-alpine AS deps-prune

RUN apk add --no-cache python3 make g++ libc6-compat
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

WORKDIR /build

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/

# Production install — strips devDeps, keeps optionalDependencies
# (better-sqlite3) and resolves workspace links.
RUN pnpm install --frozen-lockfile --prod

############################
# Stage 3 — runtime
############################
FROM node:22-alpine AS runtime

# tini = clean signal handling for PID 1; curl for healthcheck
RUN apk add --no-cache tini curl

# Non-root user
RUN addgroup -S celiums && adduser -S -G celiums celiums

WORKDIR /app

# Compiled output + pruned, workspace-aware node_modules
COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/core/package.json ./packages/core/package.json
COPY --from=builder /build/packages/types ./packages/types
COPY --from=deps-prune /build/node_modules ./node_modules
COPY --from=deps-prune /build/packages/core/node_modules ./packages/core/node_modules

# Migration scripts + schemas (used by `celiums migrate up`)
COPY --from=builder /build/scripts ./scripts
COPY --from=builder /build/schemas ./schemas

RUN chown -R celiums:celiums /app
USER celiums

ENV NODE_ENV=production
ENV PORT=3210
EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3210/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/core/dist/quickstart.js"]
