# Deployment & Infrastructure

## Overview

Code Review Agent is a split-deployment system: the **NestJS API** runs on [Render.com](https://render.com) alongside a managed Redis instance, and the **Next.js client** is deployed to [Vercel](https://vercel.com). For local development, a Docker Compose configuration runs all three services together. The Neon PostgreSQL database (with pgvector) is a shared external dependency across all environments.

---

## Production Architecture

```
Users
  │
  ▼
Vercel CDN / Edge
  Next.js Client
  (SSR + static assets)
        │
        │ HTTPS API calls
        ▼
Render.com (Web Service)
  NestJS API — PORT 10000
        │
        ├── Redis (Render managed)    ← BullMQ queue + Streams event log + cancel channel
        └── Neon PostgreSQL           ← Users, Reviews, RAG vectors
              (external — shared across envs)
```

---

## Render.com — API + Redis

Defined in [`render.yaml`](../render.yaml) at the repository root.

### Redis

```yaml
- type: redis
  name: code-review-agent-redis
  plan: free
  ipAllowList: []
```

A managed Redis instance. The `REDIS_URL` environment variable is automatically injected into the API service via `fromService.property: connectionString`. No manual configuration needed.

### NestJS Web Service

```yaml
- type: web
  name: code-review-agent-api
  env: node
  branch: main
  buildCommand: pnpm install && pnpm build:packages && pnpm --filter server build
  startCommand: pnpm --filter server start:prod
```

**Build filter:** Matches changes to `apps/server/**`, `packages/**`, or root config files. Explicitly excludes `docs/**` and `README.md` to prevent unnecessary API builds.

**Build steps:**
1. `pnpm install` — installs all workspace dependencies
2. `pnpm build:packages` — compiles `@cra/types` then `@cra/ai`
3. `pnpm --filter server build` — `prisma generate` + `nest build` (swc transpile) for the NestJS app

**Start:** `pnpm --filter server start:prod` — runs the compiled `dist/main.js` via `node`.

**Port:** `10000` (Render's default for web services).

**Deploy branch:** the blueprint pins `branch: main`, so only pushes to `main` auto-deploy the API. Day-to-day development happens on `develop` and never triggers a deploy — merge `develop` → `main` to ship.

### Required Environment Variables (Render Dashboard)

| Variable | Notes |
|---|---|
| `NODE_ENV` | Set to `production` in `render.yaml` |
| `PORT` | Set to `10000` in `render.yaml` |
| `REDIS_URL` | Auto-injected from the managed Redis service |
| `FRONTEND_URL` | The Vercel deployment URL (for CORS) |
| `AI_GATEWAY_API_KEY` | Required — serves the embedding tier in every configuration, plus chat tiers when `AI_ROUTER=vercel-gateway` (the default) |
| `AI_ROUTER` | *(Optional)* Chat router: `vercel-gateway` (default) or `openrouter` — restart to switch |
| `OPENROUTER_API_KEY` | Required only when `AI_ROUTER=openrouter` — chat calls fail without it |
| `DATABASE_URL` | Neon pooled connection string |
| `DIRECT_URL` | Neon direct connection string (for Prisma) |
| `RAZORPAY_KEY_ID` | Razorpay Key ID (publishable) |
| `RAZORPAY_KEY_SECRET` | Razorpay Key Secret (server-only) |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Webhook Secret (server-only, for HMAC validation) |
| `GITHUB_TOKEN` | *(Optional)* For private repo PR reviews; declared as a secret in `render.yaml` |

> `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are **client-only** (NextAuth reads them in `apps/client`) — set them in Vercel, not Render; the server never reads them. `GROQ_API_KEY` and `HELICONE_API_KEY` appear in `.env.example` under "Not implemented (reserved)" and have no code support — do not configure them.

---

## Vercel — Next.js Client

Configured in [`apps/client/vercel.json`](../apps/client/vercel.json).

The Vercel project's **Root Directory is `apps/client`** — `vercel.json` overrides the install/build commands to run from the monorepo root (`cd ../.. && pnpm …`) so the workspace packages are resolvable. A custom `ignoreCommand` gates builds: a push only triggers a client deploy when the commit ref is `main` **and** the diff touches `apps/client`, `packages/`, or the root manifests.

### Required Environment Variables (Vercel Dashboard)

| Variable | Notes |
|---|---|
| `NEXTAUTH_URL` | Full public URL of the Vercel deployment |
| `NEXTAUTH_SECRET` | Random 32+ character secret (generate with `openssl rand -base64 32`) |
| `GITHUB_CLIENT_ID` | Same GitHub OAuth App as the server |
| `GITHUB_CLIENT_SECRET` | Same GitHub OAuth App as the server |
| `NEXT_PUBLIC_API_URL` | The Render.com API URL, e.g. `https://code-review-agent-api.onrender.com` |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Razorpay Key ID (publishable, safe for browser) |

---

## GitHub OAuth App Setup

Both environments (and local dev) require a GitHub OAuth App.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set **Homepage URL** to your client URL (e.g. `https://your-app.vercel.app`) 
3. Set **Authorization callback URL** to `{NEXTAUTH_URL}/api/auth/callback/github`
4. Copy **Client ID** and **Client Secret** into both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`

For local development, create a **separate OAuth App** pointing to `http://localhost:3000`.

---

## Local Development

### Option A — `pnpm dev` (recommended for active development)

Requires a local or cloud Redis and a Postgres database.

```bash
# 1. Install dependencies
pnpm install

# 2. Fill in environment files
cp apps/server/.env.example apps/server/.env
cp apps/client/.env.example apps/client/.env
# Edit both .env files

# 3. Run database migrations
cd apps/server && npx prisma migrate deploy && cd ../..

# 4. Start both apps concurrently
pnpm dev
# → Client: http://localhost:3000
# → Server: http://localhost:4000
```

`pnpm dev` runs `pnpm build:packages` first (compiles shared packages), then starts both apps concurrently with `concurrently`.

### Option B — Docker Compose (all-in-one)

Runs Redis, the NestJS server, and the Next.js client in containers. Requires Docker Desktop.

```bash
# Fill in .env files first (see above)

docker compose up --build
```

Services started:
- `cra-redis` → `localhost:6379`
- `cra-server` → `http://localhost:4000`
- `cra-client` → `http://localhost:3000`

The server waits for Redis to pass its health check before starting. The client waits for the server to start.

**Note:** `docker-compose.yml` reads `apps/server/.env` and `apps/client/.env` via `env_file`. The `REDIS_URL` inside the server container is overridden to `redis://redis:6379` (the Docker network hostname).

---

## Database — Neon PostgreSQL

The system requires PostgreSQL 15+ with the `pgvector` extension enabled. [Neon](https://neon.tech) is the recommended provider (free tier available) because it supports pgvector natively.

**Two connection strings are required:**
- `DATABASE_URL` — the pooled (PgBouncer) connection, used for all queries
- `DIRECT_URL` — the direct connection, used only by Prisma for migrations

### Running Migrations

```bash
# From apps/server/
npx prisma migrate deploy      # production (apply only)
npx prisma migrate dev         # development (create + apply)
npx prisma studio              # visual DB browser
```

For the coverage-safe PR pipeline, test migration `20260718090000_add_partial_review_coverage` on a Neon branch first. Apply it in production before deploying code that writes `PARTIAL`:

```bash
pnpm --filter server exec prisma migrate deploy
```

Deploy in this order: database migration, server, then client. The new enum value and nullable `coverage` JSONB column leave historical rows and trace logs valid.

---

## Dockerfiles

Both apps have multi-stage Dockerfiles for minimal production images.

### `apps/server/Dockerfile`

- Stage 1 (`builder`): installs all dependencies, builds packages, builds the NestJS app
- Stage 2 (`runner`): production-only image, copies `dist/` and `node_modules/`, runs `start:prod`

### `apps/client/Dockerfile`

- Stage 1 (`builder`): installs, builds packages, runs `next build`
- Stage 2 (`runner`): production-only image; copies the standalone bundle (`.next/standalone` + `.next/static`) and runs `node apps/client/server.js`
- `NEXT_PUBLIC_API_URL` is a build ARG so it can be baked in at image build time

---

## Deployment Checklist

### Initial Deploy

- [ ] Create GitHub OAuth App (production callback URL)
- [ ] Provision Neon database; enable `pgvector` extension
- [ ] Deploy Redis + API to Render.com; set all env vars
- [ ] Run `prisma migrate deploy` (can be done via Render's one-off job or manually)
- [ ] Deploy client to Vercel; set all env vars
- [ ] Set `FRONTEND_URL` on Render to the Vercel deployment URL
- [ ] Set `NEXTAUTH_URL` on Vercel to the Vercel deployment URL
- [ ] Set `NEXT_PUBLIC_API_URL` on Vercel to the Render API URL
- [ ] Test sign-in flow end-to-end
- [ ] Submit a code review to verify the full pipeline

### Subsequent Deploys

- API: push to `main` branch → Render auto-deploys (only if server/packages changed)
- Client: push to `main` branch → Vercel auto-deploys
- Database schema changes: run `prisma migrate deploy` before/during API deploy

---

## Environment Variable Reference

### Server (`apps/server/.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | API port (default `4000`) |
| `DATABASE_URL` | Yes | Neon pooled PostgreSQL URL |
| `DIRECT_URL` | Yes | Neon direct PostgreSQL URL |
| `AI_ROUTER` | No | Chat router selection: `vercel-gateway` (default) or `openrouter`; embeddings always stay on the Vercel AI Gateway |
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway key — one key reaches many providers with zero markup on token prices; BYOK (bring-your-own provider keys) supported in the Vercel dashboard. Required even with `AI_ROUTER=openrouter` (embeddings) |
| `OPENROUTER_API_KEY` | Only when `AI_ROUTER=openrouter` | OpenRouter key — large free/cheap model catalog |
| `REDIS_URL` | Yes | Redis connection string |
| `GITHUB_CLIENT_ID` | No — client-only | Read by NextAuth in `apps/client`, never by the server |
| `GITHUB_CLIENT_SECRET` | No — client-only | Same as above |
| `FRONTEND_URL` | Yes | Client origin (for CORS) |
| `GITHUB_TOKEN` | No | PAT for private repo PR access; present in `.env.example` and must be supplied per environment |
| `HELICONE_API_KEY` | No | **Not implemented** — reserved (roadmap: AI observability) |
| `GROQ_API_KEY` | No | **Not implemented** — reserved (roadmap: alternative provider) |
| `STRIPE_SECRET_KEY` | No | **Not implemented** — reserved (roadmap: billing) |
| `STRIPE_WEBHOOK_SECRET` | No | **Not implemented** — reserved |
| `STRIPE_PRO_PRICE_ID` | No | **Not implemented** — reserved |
| `JWT_SECRET` | No | **Legacy/unused.** Present in `.env.example` but the auth system uses GitHub tokens directly — no JWT is issued or verified |
| `JWT_EXPIRES_IN` | No | **Legacy/unused.** Same as above |

### Client (`apps/client/.env`)

| Variable | Required | Description |
|---|---|---|
| `NEXTAUTH_URL` | Yes | Client public URL |
| `NEXTAUTH_SECRET` | Yes | NextAuth session encryption secret |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth App client secret |
| `NEXT_PUBLIC_API_URL` | Yes | Backend URL |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | No | **Not implemented** — reserved (roadmap: billing) |

---

## Related Files

| File | Role |
|---|---|
| [`render.yaml`](../render.yaml) | Render.com deployment manifest (API + Redis) |
| [`apps/client/vercel.json`](../apps/client/vercel.json) | Vercel routing configuration |
| [`docker-compose.yml`](../docker-compose.yml) | Local all-in-one dev environment |
| [`apps/server/Dockerfile`](../apps/server/Dockerfile) | NestJS production image |
| [`apps/client/Dockerfile`](../apps/client/Dockerfile) | Next.js production image |
| [`apps/server/.env.example`](../apps/server/.env.example) | Server env var template |
| [`apps/client/.env.example`](../apps/client/.env.example) | Client env var template |
| [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma) | Database schema |
