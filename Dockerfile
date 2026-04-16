FROM node:22-alpine

# Native build tools for esbuild/better-sqlite3
RUN apk add --no-cache python3 make g++ 

RUN npm install -g pnpm tsx

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/ packages/

# Install with native rebuild
RUN pnpm install

# Build TypeScript
RUN cd packages/types && npx tsc || true
RUN cd packages/core && npx tsc || true
RUN cd packages/knowledge && npx tsc || true

CMD ["npx", "tsx", "packages/core/src/quickstart.ts"]
