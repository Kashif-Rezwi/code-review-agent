# Architecture

## Overview

Code Review Agent is a monorepo containing two applications (`client` and `server`) and two shared packages (`@cra/ai` and `@cra/types`). The system is designed around a **queue-backed, event-streaming** model: HTTP requests create jobs, background workers execute them, and results are pushed to clients in real time via SSE backed by Redis pub/sub.

---

## Component Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          pnpm Monorepo                                      │
│                                                                             │
│  ┌──────────────────────────┐    ┌───────────────────────────────────────┐  │
│  │   apps/client            │    │   apps/server                         │  │
│  │   (Next.js 16)           │    │   (NestJS)                            │  │
│  │                          │    │                                       │  │
│  │  ┌─────────────────────┐ │    │  ┌───────────┐  ┌──────────────────┐  │  │
│  │  │  Pages (App Router) │ │    │  │  auth/    │  │  review/         │  │  │
│  │  │  /review            │ │    │  │           │  │  ├ controller    │  │  │
│  │  │  /history           │◄├────┤  │  github/  │  │  ├ service       │  │  │
│  │  │  /standards         │ │    │  │           │  │  ├ processor     │  │  │
│  │  │  /login             │ │    │  │  rag/     │  │  ├ streamer      │  │  │
│  │  └─────────────────────┘ │    │  │           │  │  └ repository    │  │  │
│  │                          │    │  │ history/  │  └──────────────────┘  │  │
│  │  ┌─────────────────────┐ │    │  │           │                        │  │
│  │  │  lib/               │ │    │  │ queue/    │  ┌──────────────────┐  │  │
│  │  │  useReviewStream    │ │    │  │  ├ BullMQ │  │  linter/         │  │  │
│  │  │  reviewStreamReducer│ │    │  │  └ Redis  │  │  (in-proc ESLint)│  │  │
│  │  │  useChatMessages    │ │    │  └───────────┘  └──────────────────┘  │  │
│  │  └─────────────────────┘ │    │                                       │  │
│  └──────────────────────────┘    └───────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  packages/                                                            │  │
│  │  ├── @cra/ai     — prompts, AI tools, cluster planner, embeddings     │  │
│  │  └── @cra/types  — ReviewStreamEvent union, ReviewData Zod schema     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘

External dependencies
  ├── OpenAI API        (AI model + embeddings)
  ├── GitHub API        (OAuth, user profile, PR diffs)
  ├── PostgreSQL/Neon   (pgvector — reviews, users, RAG chunks)
  └── Redis             (BullMQ jobs + pub/sub channels + replay lists)
```

---

## Request Lifecycle (Happy Path)

```
1. Browser              POST /review/session
                        Authorization: Bearer <github_token>
                        { type: "PR", input: "https://github.com/.../pull/42" }

2. AuthGuard            Validates token → resolves userId

3. ReviewController     Creates Review row (status=PENDING, id=<cuid>)
                        Enqueues BullMQ job { reviewId, type, input, userId }
                        Returns { reviewId }

4. Browser              Navigates to /review/github_pr/<reviewId>
                        Opens SSE: GET /review/<reviewId>/stream

5. ReviewStreamerService Replays Redis history (empty at this point)
                        Checks DB status: PENDING → subscribe to Redis channel re:<reviewId>

6. BullMQ Worker        Picks up job from review-jobs queue
                        ReviewProcessor.process(job) fires

7. ReviewService        createRedisEmitter(reviewId) — all events go to Redis
                        Runs review pipeline (see review-pr.md or review-code.md)
                        Emits: start → task_plan → task_updates → cluster_plan
                               → thinking/tool events → complete

8. Redis                Each event is:
                        - Appended to replay list  rl:<reviewId>  (TTL 1 hour)
                        - Published on channel     re:<reviewId>

9. ReviewStreamerService Receives each publish, forwards to SSE subscriber.next()
                        On complete or error event → subscriber.complete()

10. Browser             consumeSSEStream dispatcher fires for each event
                        reviewStreamReducer updates state
                        UI renders progress → result panel
```

---

## Module Dependency Graph (Server)

```
AppModule
  ├── ConfigModule (global)
  ├── PrismaModule          ◄── used by all repos
  ├── AiModule              ◄── provides OpenAI provider + models
  ├── AuthModule
  │     └── GithubModule (for /user validation)
  ├── RagModule
  │     ├── AiModule (embeddings)
  │     └── PrismaModule
  ├── ReviewModule
  │     ├── AiModule
  │     ├── GithubModule
  │     ├── LinterModule
  │     ├── RagModule
  │     ├── HistoryModule
  │     └── QueueModule
  ├── HistoryModule
  │     ├── AiModule (chat completions)
  │     └── PrismaModule
  └── QueueModule
        └── RedisModule (ioredis)
```

---

## Shared Package Role

### `@cra/ai`

The AI package is the single source of truth for all LLM-facing abstractions:

- **Prompts** — system prompt builders for code review, worker agents, and synthesis
- **Tools** — Vercel AI SDK tool definitions: `fetchGithubPR`, `listPRFiles`, `fetchFileContent`, `runLinter`
- **Cluster planner** — `planClusters()` — groups PR files into domain clusters using `gpt-4o-mini`
- **Embeddings** — `chunkText()` — text chunking utility for RAG ingestion

The server imports from `@cra/ai`; the package has no awareness of NestJS or HTTP.

### `@cra/types`

Defines the shared contract between the server's streaming output and the client's SSE consumer:

- **`ReviewStreamEvent`** — a discriminated union of all possible SSE event shapes (`start`, `thinking`, `tool_start`, `tool_done`, `task_plan`, `task_update`, `cluster_plan`, `cluster_done`, `complete`, `error`)
- **`ReviewData`** / **`ReviewDataSchema`** — the final review output structure, validated with Zod on both sides

Both packages are built before the apps (`pnpm build:packages`) and consumed as local workspace dependencies.

---

## Data Stores

| Store | Purpose | TTL / Retention |
|---|---|---|
| **PostgreSQL** | Users, reviews, issues, conversations, RAG chunks + embeddings | Permanent |
| **Redis — BullMQ** | Job queue (`review-jobs` queue) | Cleaned up: success after 1h, failure after 3d |
| **Redis — replay list** | `rl:<reviewId>` — ordered list of all emitted events | 1 hour TTL |
| **Redis — pub/sub** | `re:<reviewId>` channel — live event broadcast | Ephemeral (no persistence) |

---

## Deployment Topology

```
Vercel (CDN + serverless)         Render.com
┌──────────────────┐              ┌──────────────────────────┐
│  Next.js Client  │──── HTTPS ──►│  NestJS Server (Node)    │
│  (Edge + SSR)    │              │  PORT 10000              │
└──────────────────┘              └───────────┬──────────────┘
                                              │
                                  ┌───────────▼──────────────┐
                                  │  Redis (Render managed)  │
                                  └──────────────────────────┘
                                              │
                                  ┌───────────▼──────────────┐
                                  │  Neon PostgreSQL         │
                                  │  (+ pgvector extension)  │
                                  └──────────────────────────┘
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| Queue-backed reviews | Decouples HTTP from long AI pipelines and keeps pending work addressable by review ID; expensive LLM jobs are not auto-retried |
| Redis as both queue broker and SSE relay | Single infrastructure dependency; pub/sub with replay list makes late-joining SSE safe |
| Shared `@cra/types` package | Ensures client and server always agree on the SSE event contract at compile time |
| `@cra/ai` as a standalone package | Prompts and tools can be tested/updated independently of the NestJS runtime |
| No server-issued JWTs | Reduces complexity; the GitHub token is a sufficient credential and avoids token refresh machinery |

---

## Related Files

| File | Role |
|---|---|
| [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | Declares workspace packages |
| [`package.json`](../package.json) | Root build scripts |
| [`apps/server/src/app.module.ts`](../apps/server/src/app.module.ts) | NestJS root module — module wiring |
| [`apps/server/src/main.ts`](../apps/server/src/main.ts) | Bootstrap: CORS, port, app init |
| [`render.yaml`](../render.yaml) | Render.com deployment manifest |
| [`apps/client/vercel.json`](../apps/client/vercel.json) | Vercel routing config |
