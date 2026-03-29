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
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
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

# 2. Build-time ARGs for Prisma schema validation (ARG-only — never baked into the image)
ARG DATABASE_URL
ARG DIRECT_URL

# 3. Build NestJS
RUN pnpm --filter server build

# 4. Isolate the server and its production dependencies (including shared workspace packages) into a standalone folder
RUN pnpm deploy --filter server --prod --legacy /app/deploy

# 5. Generate Prisma client directly inside the isolated deploy folder (single layer)
RUN cp -r apps/server/prisma /app/deploy/prisma && \
    cd /app/deploy && npx prisma@6 generate

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: runner — minimal production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

ENV NODE_ENV=production

WORKDIR /app

# Copy the completely isolated, production-ready server and perfectly baked Prisma client
COPY --from=build /app/deploy ./

# Run as non-root user
USER node

EXPOSE 4000

# Healthcheck — TCP-level check: if port 4000 is open, the server process is alive
# Using nc instead of wget because busybox wget exits 1 on any 4xx HTTP response
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD nc -z localhost 4000 || exit 1

CMD ["node", "dist/main"]
