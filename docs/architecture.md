# Architecture

## Overview

Code Review Agent is a monorepo containing two applications (`client` and `server`) and two shared packages (`@cra/ai` and `@cra/types`). The system is designed around a **queue-backed, event-streaming** model: HTTP requests atomically write a review plus a dispatch-outbox row, a polling dispatcher enqueues jobs, background workers execute them, and results are pushed to clients in real time via SSE backed by Redis Streams.

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
│  │  └─────────────────────┘ │    │  │           │  │  ├ repository    │  │  │
│  │                          │    │  │           │  │  └ dispatcher    │  │  │
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
  ├── Vercel AI Gateway   (AI models + embeddings)
  ├── GitHub API        (OAuth, user profile, PR diffs)
  ├── PostgreSQL/Neon   (pgvector — reviews, users, RAG chunks, payments)
  ├── Redis             (BullMQ jobs + Streams event log + cancellation channel)
  └── Razorpay API      (Orders, Checkout.js, HMAC webhooks)
```

---

## Request Lifecycle (Happy Path)

```
1. Browser              POST /review/session
                        Authorization: Bearer <github_token>
                        { type: "PR", input: "https://github.com/.../pull/42" }

2. AuthGuard            Validates token → resolves userId

3. ReviewController     One tx: Review row (PENDING) + ReviewDispatch outbox row
                        Returns { reviewId } — the dispatcher enqueues asynchronously

4. Browser              Navigates to /review/github_pr/<reviewId>
                        Opens SSE: GET /review/<reviewId>/stream

5. ReviewStreamerService XREAD from 0-0 (or Last-Event-ID when resuming)
                        Empty stream → blocking 15s reads + heartbeats until events arrive

6. BullMQ Worker        Picks up job from review-jobs queue
                        ReviewProcessor.process(job) fires

7. ReviewService        createRedisEmitter(reviewId) — all events go to Redis
                        Runs review pipeline (see review-pr.md or review-code.md)
                        Emits: start → acquisition → task plan/updates → cluster plan
                               → worker events → synthesis → complete/partial

8. Redis                Each event is:
                        - XADD-appended to stream  review:events:<reviewId>
                          (MAXLEN ~ 5000, TTL 24 hours)

9. ReviewStreamerService Forwards each stream entry to SSE (id: <stream-id>)
                        On complete/error (or a terminal DB row) → subscriber.complete()

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
  ├── AiModule              ◄── provides AI Gateway provider + tiered models
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
- **Tools** — one Vercel AI SDK tool definition: `runLinter` (pasted-code path only; GitHub PR acquisition is orchestrated server-side before any model call, so no model-facing GitHub tools exist)
- **Cluster planner** — `planClusters()` — groups PR files with the centrally configured model, then enforces exact-once coverage
- **Embeddings** — `chunkText()` — text chunking utility for RAG ingestion

The server imports from `@cra/ai`; the package has no awareness of NestJS or HTTP.

### `@cra/types`

Defines the shared contract between the server's streaming output and the client's SSE consumer:

- **`ReviewStreamEvent`** — the typed SSE union, including acquisition, cluster success/failure, synthesis and complete/partial outcome events
- **`ReviewData`** / **`ReviewDataSchema`** — the final review output structure, validated with Zod on both sides

Both packages are built before the apps (`pnpm build:packages`) and consumed as local workspace dependencies.

---

## Data Stores

| Store | Purpose | TTL / Retention |
|---|---|---|
| **PostgreSQL** | Users, reviews, issues, conversations, review-dispatch outbox, RAG chunks + embeddings | Permanent |
| **Redis — BullMQ** | Job queue (`review-jobs` queue) | Cleaned up: success after 1h, failure after 3d |
| **Redis — event stream** | `review:events:<reviewId>` — Redis Stream of all emitted events (the replay log) | 24h TTL, MAXLEN ~ 5000 |
| **Redis — cancellation** | `review:cancel:<reviewId>` — TTL key + pub/sub channel for abort signals | 600s TTL |

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
                                  └───────────┬──────────────┘
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
| Redis as both queue broker and SSE relay | Single infrastructure dependency; the Redis Stream doubles as the replay log, so late-joining SSE has no subscribe gap |
| Postgres dispatch outbox | HTTP never blocks on Redis; a crash between review-write and enqueue can never strand work — the dispatcher reconciles |
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
