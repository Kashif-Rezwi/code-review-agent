# Queue & Streaming System

## Overview

Reviews are long-running, expensive AI operations that cannot be executed synchronously within an HTTP request. The system uses a **BullMQ job queue** backed by Redis to decouple the HTTP layer from the AI pipeline. Results are delivered to the browser via **Server-Sent Events (SSE)**, routed through **Redis pub/sub** with a **replay list** for connection resilience.

---

## High-Level Design

```
HTTP Layer                 Queue Layer                  Client Layer
─────────────              ────────────                 ────────────
POST /review/session       BullMQ Worker                SSE Consumer
  │                          │                            │
  │── enqueue job ──────────►│                            │
  │◄── { reviewId } ─────────│                            │
                             │── run AI pipeline          │
                             │      │                     │
                             │  emit event ──►Redis──────►│
                             │      │         pub/sub     │
                             │      │         + replay    │
                             │◄─────┘                     │
                             │ pipeline done              │
                                                          │
GET /review/:id/stream ──────────────────────────────────►│
                                  replay history          │
                                  + subscribe live        │
```

---

## Components

### `QueueService` + BullMQ

`src/queue/queue.service.ts` injects the BullMQ `Queue` instance (named `review-jobs`) and exposes a single `enqueue(payload)` method.

Job options are deliberately conservative:
- `jobId: reviewId` — the BullMQ job ID maps directly to the database Review ID, enabling O(1) lookups
- `attempts: 1` — LLM pipelines are expensive and non-idempotent; no automatic retries
- `removeOnComplete: { age: 3600 }` — successful jobs cleaned up from Redis after 1 hour
- `removeOnFail: { age: 86400 * 3 }` — failed jobs retained for 3 days for debugging

### `ReviewProcessor`

`src/review/review.processor.ts` is the BullMQ worker. It extends `WorkerHost` and is bound to the `review-jobs` queue via `@Processor('review-jobs')`.

**On job receipt (`process` method):**
1. Calls `createRedisEmitter(this.redisService, reviewId)` — creates an `SseConnection`-compatible object that routes all events to Redis instead of directly to an HTTP response.
2. Calls `ReviewService.runForQueue(reviewId, type, input, userId, conn)` — runs the full AI pipeline.
3. All errors are caught internally by `runForQueue`; the processor does **not** throw to BullMQ (preventing unwanted retries).

**On worker failure (`@OnWorkerEvent('failed')`):**
If BullMQ itself terminates the job (e.g. Node process stall), the handler:
1. Forces `FAILED` status in Postgres.
2. Emits a `{ type: "error" }` event to Redis so any waiting SSE clients receive a terminal signal.

### `RedisService`

`src/queue/redis.service.ts` manages two ioredis connections:
- `publisher` — a persistent connection used for all write operations (append to list, set TTL, publish)
- Subscribers — created on demand via `createSubscriber()` and used by `ReviewStreamerService`

The `emitEvent(reviewId, message)` method is the core primitive. It uses a Redis pipeline (atomic batch) to:
1. `RPUSH rl:<reviewId> <message>` — append to the replay list
2. `EXPIRE rl:<reviewId> 3600` — reset TTL to 1 hour
3. `PUBLISH re:<reviewId> <message>` — broadcast to live subscribers

This is done in a single round-trip.

### `createRedisEmitter`

`src/queue/review.emitter.ts` is a factory that creates an object conforming to the `SseConnection` interface but backed by Redis instead of an HTTP response:

```
SseConnection interface:
  send(event)  → pushes to Redis replay list + pub/sub channel
  getTrace()   → returns in-memory array of all emitted events
  startedAt    → timestamp for duration calculation
```

This abstraction means `ReviewService` is completely agnostic to whether it is streaming directly to an HTTP client or via Redis — the same pipeline code runs in both paths.

### `ReviewStreamerService`

`src/review/review-streamer.service.ts` handles the client-facing SSE stream for `GET /review/:id/stream`.

**Initialization sequence:**
1. Validates the review belongs to the requesting user (`HistoryService.getReview`).
2. Fetches all events from the Redis replay list (`RedisService.getLog`).
3. Replays them synchronously to the SSE subscriber.
4. Checks the DB `status` field:
   - If `COMPLETE` or `FAILED` and the **replay list was empty** (TTL expired): synthesises one terminal event and closes.
     - `COMPLETE` → `{ type: 'complete', review: { id: review.id } }`
     - `FAILED` → `{ type: 'error', message: review.summary || 'Review failed' }`
   - If `COMPLETE` or `FAILED` and the **replay list was non-empty**: replay is sufficient; stream closes without a synthesised event.
   - If `PENDING`: create a fresh Redis subscriber and subscribe to `re:<reviewId>`.
5. Forwards each incoming pub/sub message to the SSE subscriber.
6. On `complete` or `error` event, tears down the Redis subscriber and completes the Observable.

**Teardown:** On client disconnect (browser closes tab, navigates away), the Observable teardown callback quits the Redis subscriber connection immediately.

---

## `SseConnection` Interface

```typescript
interface SseConnection {
  send: (event: ReviewStreamEvent) => void
  startedAt: number
  getTrace: () => ReviewStreamEvent[]
}
```

Two concrete implementations:
- `initSse(res)` — writes directly to an Express HTTP response (retained but not used in the current queue-first path)
- `createRedisEmitter(redis, reviewId)` — routes through Redis (the active path)

---

## Event Flow Detail

```
ReviewProcessor.process(job)
  │
  └─► createRedisEmitter(reviewId) → conn
  └─► ReviewService.runForQueue(reviewId, type, input, userId, conn)
          │
          ├── conn.send({ type: "start" })
          │      └─► Redis: RPUSH rl:<id> {...}, PUBLISH re:<id> {...}
          │
          ├── [pipeline runs...]
          │
          ├── conn.send({ type: "thinking", text: "..." })
          ├── conn.send({ type: "tool_start", ... })
          ├── conn.send({ type: "tool_done", ... })
          │
          └── conn.send({ type: "complete", review: {...} })
                 └─► Redis: appended to replay list + published

ReviewStreamerService (SSE endpoint)
  │
  ├── replay: getLog(reviewId) → send all historical events → subscriber.next()
  │
  └── subscribe: redisSub.on("message") → subscriber.next()
                   on "complete" or "error" → subscriber.complete()
```

---

## Redis Key Schema

| Key pattern | Type | Purpose | TTL |
|---|---|---|---|
| `rl:<reviewId>` | List | Ordered SSE event replay log | 1 hour |
| `re:<reviewId>` | Pub/sub channel | Live event broadcast | Ephemeral |
| BullMQ internal keys | Various | Job queue management | Managed by BullMQ |

---

## Responsibilities

| Component | Owns |
|---|---|
| `QueueService` | Job enqueueing, job options |
| `ReviewProcessor` | Job lifecycle, BullMQ worker binding, failure recovery |
| `RedisService` | Redis connections, atomic emit, replay log |
| `createRedisEmitter` | `SseConnection` adapter for the queue path |
| `ReviewStreamerService` | Client-facing SSE Observable, replay + live subscription |

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Client connects after review completes | Replay list replayed synchronously; DB status checked; `complete` sent; stream closed |
| Client connects before pipeline starts | Replay list is empty; subscribes live; receives all events as they arrive |
| Redis goes down mid-review | `emitEvent` calls fail silently (`.catch(console.error)`); DB save still attempted at pipeline end |
| Node process restarts mid-job | `@OnWorkerEvent("failed")` fires; Postgres marked FAILED; error event emitted to Redis |
| Two clients for the same review | Both subscribe to `re:<reviewId>`; both receive every event independently |
| SSE client disconnects | Observable teardown quits the Redis subscriber; no memory leak |
| Late replay with empty list but COMPLETE DB status | `ReviewStreamerService` synthesises `{ type: 'complete', review: { id } }` so the client transitions to the completed state without hanging |
| Late replay with empty list but FAILED DB status | `ReviewStreamerService` synthesises `{ type: 'error', message: review.summary }` so the client shows an error instead of hanging |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/queue/queue.service.ts`](../apps/server/src/queue/queue.service.ts) | BullMQ enqueue |
| [`apps/server/src/queue/queue.module.ts`](../apps/server/src/queue/queue.module.ts) | BullMQ + Redis module wiring |
| [`apps/server/src/queue/redis.service.ts`](../apps/server/src/queue/redis.service.ts) | ioredis connections, `emitEvent`, `getLog` |
| [`apps/server/src/queue/review.emitter.ts`](../apps/server/src/queue/review.emitter.ts) | Redis-backed `SseConnection` factory |
| [`apps/server/src/review/review.processor.ts`](../apps/server/src/review/review.processor.ts) | BullMQ worker |
| [`apps/server/src/review/review-streamer.service.ts`](../apps/server/src/review/review-streamer.service.ts) | Client SSE Observable |
| [`apps/server/src/review/review.sse.ts`](../apps/server/src/review/review.sse.ts) | `SseConnection` interface + `initSse` |
| [`apps/server/src/review/review.controller.ts`](../apps/server/src/review/review.controller.ts) | `POST /review/session`, `GET /review/:id/stream` |
