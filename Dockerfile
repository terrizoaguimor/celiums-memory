# SPDX-License-Identifier: Apache-2.0
# Celiums Memory — production Dockerfile.
#
# Multi-stage build per ADR-018 §"Reproducible-ish builds":
#   - Stage 1 (deps): pin pnpm + install + native rebuild on alpine
#   - Stage 2 (build): compile TypeScript via tsup
#   - Stage 3 (runtime): distroless base, non-root, read-only fs
#
# Image identity baked at /etc/celiums-build-info per ADR-018.
#
# NOTE (pre-release TODO): pin base image SHAs (not tags) per
# ADR-018 §"Reproducible-ish builds". The tags below are what
# Dependabot tracks; tag-to-SHA conversion happens in CI.

# ── Stage 1: dependencies ──────────────────────────────────────────
FROM node:22-alpine AS deps

# Build tools for native modules (better-sqlite3 etc.)
RUN apk add --no-cache python3 make g++ git

# Pin pnpm to a known version. Floats only via Dependabot.
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /build

# Copy workspace + lockfile FIRST so layer caches on dep changes only.
# .npmrc MUST be here (before `pnpm install`) so node-linker=hoisted
# applies — incident 2026-05-16: without it pnpm's isolated layout left
# pg/ajv under packages/core/node_modules, unresolvable from /app/dist at
# runtime → ERR_MODULE_NOT_FOUND → prod CrashLoop.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY packages/ packages/

# Frozen lockfile install — fail if lockfile out of sync.
RUN pnpm install --frozen-lockfile

# ── Stage 2: build ─────────────────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /build
COPY --from=deps /build /build
COPY . .

# Build the core package (publishes dist/).
RUN pnpm --filter @celiums/memory build

# Build info baked at compile time.
ARG BUILD_DATE
ARG BUILD_SHA
ARG VERSION
RUN echo "version=${VERSION:-dev}\ncommit=${BUILD_SHA:-unknown}\nbuilt_at=${BUILD_DATE:-unknown}" \
    > /build/build-info.txt

# Prune dev deps for the runtime stage.
RUN pnpm install --prod --frozen-lockfile

# ── Stage 3: runtime (distroless) ──────────────────────────────────
# Distroless gives us:
#   - No shell, no package manager → no remote-command exec surface
#   - Smaller image (~80 MB vs ~250 MB on node:alpine)
#   - Non-root by default (the `nonroot` user is uid 65532)
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime

LABEL org.opencontainers.image.source="https://github.com/celiums/celiums-memory" \
      org.opencontainers.image.description="Celiums Memory — persistent memory infrastructure for AI agents" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Celiums Solutions LLC"

WORKDIR /app

# Copy only what the runtime needs.
COPY --from=build --chown=nonroot:nonroot /build/build-info.txt /etc/celiums-build-info
COPY --from=build --chown=nonroot:nonroot /build/packages/core/dist /app/dist
COPY --from=build --chown=nonroot:nonroot /build/packages/core/package.json /app/package.json
COPY --from=build --chown=nonroot:nonroot /build/node_modules /app/node_modules
COPY --from=build --chown=nonroot:nonroot /build/packages/core/node_modules /app/packages/core/node_modules

# distroless image's `nonroot` is uid 65532, already configured.
USER 65532:65532

# HTTP API + Prometheus metrics endpoint.
EXPOSE 3210 3211

# Read-only filesystem in production (set via Helm chart
# securityContext.readOnlyRootFilesystem: true). The /tmp emptyDir
# is the only writeable path.

CMD ["/app/dist/quickstart.js"]
