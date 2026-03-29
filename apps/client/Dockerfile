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

# git is required because @nanostores/react is a git+https:// dependency.
# Installed here (not in base) so it doesn't pollute unrelated stages.
RUN apk add --no-cache git

# Copy manifests for all workspace members so pnpm can resolve the full graph
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/client/package.json ./apps/client/
COPY packages/ai/package.json ./packages/ai/
COPY packages/types/package.json ./packages/types/

# Mount pnpm store cache — avoids re-downloading packages on every build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: build — compile workspace packages then Next.js
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS build

# Copy shared packages first to maximize Docker layer caching
COPY packages/types ./packages/types
COPY packages/ai    ./packages/ai

# 1. Build shared packages first — needed by transpilePackages resolution
# (Changes to apps/client won't bust this cache!)
RUN pnpm --filter @cra/types build
RUN pnpm --filter @cra/ai   build

# Copy client application code AFTER packages are built
COPY apps/client    ./apps/client

# Build-time env vars for Next.js (public env vars must be baked in at build time)
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# 2. Build Next.js app (produces .next/standalone via output: 'standalone')
#    Keep WORKDIR at /app and use --filter to avoid fragile directory hops.
RUN mkdir -p apps/client/public && pnpm --filter client build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: runner — minimal standalone image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

WORKDIR /app

# Copy Next.js standalone server bundle
COPY --from=build /app/apps/client/.next/standalone ./
COPY --from=build /app/apps/client/.next/static     ./apps/client/.next/static

# Copy public folder if it exists (optional assets)
COPY --from=build /app/apps/client/public           ./apps/client/public

# Run as non-root user
USER node

EXPOSE 3000

# Next.js standalone entrypoint
CMD ["node", "apps/client/server.js"]
