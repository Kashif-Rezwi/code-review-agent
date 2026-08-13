# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: base — sets up pnpm and working directory
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: deps — install all workspace dependencies with layer caching
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS deps

# Copy manifests for all workspace members so pnpm can resolve the full graph
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/server/package.json ./apps/server/
COPY packages/ai/package.json ./packages/ai/
COPY packages/types/package.json ./packages/types/

# Mount pnpm store cache — avoids re-downloading packages on every build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: build — compile workspace packages then the NestJS app
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS build

# Copy shared packages first to maximize Docker layer caching
COPY packages/types ./packages/types
COPY packages/ai    ./packages/ai

# 1. Build shared packages (changes to apps/server won't bust this cache!)
RUN pnpm --filter @cra/types build
RUN pnpm --filter @cra/ai   build

# Copy server application code AFTER packages are built
COPY apps/server    ./apps/server

# 2. Build NestJS (prisma generate requires dummy env vars to parse the schema)
RUN DATABASE_URL="postgresql://dummy:dummy@localhost/dummy" \
    DIRECT_URL="postgresql://dummy:dummy@localhost/dummy" \
    pnpm --filter server build

# 3. Isolate the server and its production dependencies into a standalone folder
RUN pnpm deploy --filter server --prod /app/deploy

# 4. Generate Prisma client inside the isolated deploy folder — DATABASE_URL only needs
#    any valid-looking URL for codegen; the real URLs are injected at runtime via env_file.
RUN cp -r apps/server/prisma /app/deploy/prisma && \
    cd /app/deploy && \
    DATABASE_URL="postgresql://dummy:dummy@localhost/dummy" \
    DIRECT_URL="postgresql://dummy:dummy@localhost/dummy" \
    npx prisma@6 generate

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: runner — minimal production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

# Install curl for the healthcheck (more reliable than nc on Alpine)
RUN apk add --no-cache curl

# Copy the completely isolated, production-ready server and baked Prisma client
COPY --from=build /app/deploy ./

# Run as non-root user
USER node

EXPOSE 4000

# Healthcheck — HTTP-level check against the /health endpoint.
# curl -fs: -f fails on 4xx/5xx, -s suppresses progress output.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fs http://localhost:4000/health || exit 1

CMD ["node", "dist/main"]
