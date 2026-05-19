FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
COPY migrations ./migrations
RUN npx tsc

# ─────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache tini curl ca-certificates
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations

ENV NODE_ENV=production \
    PORT=5000 \
    HOST=0.0.0.0

EXPOSE 5000

USER 1000:1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:5000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
