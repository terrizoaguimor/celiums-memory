# ─────────────────────────────────────────────
#  Stage 1: Base
# ─────────────────────────────────────────────
FROM node:22-alpine AS base

RUN apk add --no-cache libc6-compat curl
RUN npm install -g pnpm@9

WORKDIR /app

# ─────────────────────────────────────────────
#  Stage 2: Dependencies
# ─────────────────────────────────────────────
FROM base AS deps

COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY turbo.json ./

COPY packages/types/package.json ./packages/types/
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
COPY packages/adapter-mcp/package.json ./packages/adapter-mcp/
COPY packages/cli/package.json ./packages/cli/

RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────────
#  Stage 3: Builder
# ─────────────────────────────────────────────
FROM deps AS builder

COPY . .

RUN pnpm turbo build --filter=@celiums/server...

# ─────────────────────────────────────────────
#  Stage 4: Production
# ─────────────────────────────────────────────
FROM node:22-alpine AS production

RUN apk add --no-cache libc6-compat curl tini
RUN npm install -g pnpm@9

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/types/package.json ./packages/types/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/adapter-mcp/dist ./packages/adapter-mcp/dist
COPY --from=builder /app/packages/adapter-mcp/package.json ./packages/adapter-mcp/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod

RUN addgroup --system --gid 1001 celiums && \
    adduser --system --uid 1001 celiums && \
    chown -R celiums:celiums /app

USER celiums

EXPOSE 3456

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]