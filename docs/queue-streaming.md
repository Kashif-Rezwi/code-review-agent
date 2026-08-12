# Queue & Streaming System

## Overview

Reviews are long-running, expensive AI operations that cannot run inside an HTTP request. The pipeline is fully decoupled from HTTP:

1. `POST /review/session` writes a `Review` row **and** a `ReviewDispatch` outbox row in **one transaction**, then returns `201 { reviewId }`. The controller never talks to BullMQ directly.
2. `ReviewDispatcherService` polls the outbox every **2 seconds**, claims rows with short leases, and enqueues BullMQ jobs.
3. `ReviewProcessor` runs the AI pipeline under a **5-minute execution deadline**, emitting progress events to a **Redis Stream** (`XADD`).
4. `ReviewStreamerService` tails the stream with a blocking `XREAD` loop and forwards entries over SSE (`@Sse` Observable), resumable via the `Last-Event-ID` header.

Redis Streams — not pub/sub — carry review events. The stream **is** the replay log, so there is no history-read/subscribe gap and no separate replay storage to keep consistent. The only remaining pub/sub use is the cancellation channel.

---

## High-Level Design

```
HTTP layer                Dispatch / queue layer                 Stream layer
────────────              ──────────────────────────             ─────────────────────
POST /review/session
  └─ tx: Review(PENDING) + ReviewDispatch(PENDING)
  └─ 201 { reviewId }
                          ReviewDispatcherService
                            poll every 2s, batch 20
                            claim: PROCESSING + 30s lease
                            retry backoff 1s→16s, 6 attempts
                                  │ QueueService.enqueue
                                  ▼   (jobId = reviewId, attempts: 1)
                          BullMQ review-jobs queue
                                  │
                                  ▼
                          ReviewProcessor.process(job)
                            createExecution(5-min deadline)
                            conn = createRedisEmitter(...)    XADD review:events:<id>
                            reviewService.runForQueue(...)    MAXLEN ~ 5000, EXPIRE 24h
                                                                   │
                                                                   ▼
                                              GET /review/:id/stream (SSE)
                                                ReviewStreamerService
                                                blocking XREAD (15s) loop
                                                  · SSE `id:` per stream entry
                                                  · heartbeat on every empty read
                                                  · terminal state reconstructed from Postgres
```

---

## Components

### `ReviewRepository.createSession` (outbox write)

`src/review/review.repository.ts` — one Prisma transaction creates the `Review` (status `PENDING`) and its `ReviewDispatch` outbox row (`PENDING`, `availableAt: now`). Because intent commits atomically with the review, a crash between "write review" and "enqueue job" can never strand work: the dispatcher picks up any committed outbox row.

### `ReviewDispatcherService` (outbox → BullMQ)

`src/review/review-dispatcher.service.ts`:

- **Poll loop** — `setInterval` every 2s (`POLL_INTERVAL_MS`), re-entrancy-guarded; `kick()` is also invoked right after each session creation for low latency.
- **Claim** — batches of 20 rows (`BATCH_SIZE`) that are `PENDING` and due, or `PROCESSING` with an expired lease. Claiming is a conditional `updateMany` (status + time predicate) that sets `PROCESSING`, increments `attempts`, and takes a **30-second lease** (`lockedUntil`) — a crashed dispatcher's rows are re-claimed after the lease expires.
- **Dispatch** — on a successful claim, loads the review and calls `QueueService.enqueue`, then marks the dispatch `DISPATCHED` (`dispatchedAt`). If the review is no longer `PENDING` (e.g. cancelled while queued), the dispatch is closed out instead (`CANCELLED`/`FAILED`).

### `QueueService` (BullMQ wrapper)

`src/queue/queue.service.ts` — queue name `review-jobs`.

- `enqueue(payload)` — `jobId = reviewId` (O(1) lookup + natural dedupe via `getJob` before `add`), `attempts: 1` (LLM pipelines are expensive and non-idempotent — **no automatic retries**), `removeOnComplete: { age: 3600 }`, `removeOnFail: { age: 3 days }`.
- `removeJob(reviewId)` — used by cancellation to drop a job that hasn't started yet; silently no-ops if the job already started or is gone.

### `ReviewProcessor` (worker)

`src/review/review.processor.ts` — `@Processor('review-jobs')`:

1. `ReviewCancellationService.createExecution(reviewId, 5 * 60_000)` — an `AbortSignal` that fires on cancellation **or** the 5-minute review deadline.
2. `createRedisEmitter(redis, reviewId)` — the stream-backed emitter (below).
3. `reviewService.runForQueue(...)` — runs the pipeline. Errors are caught inside `runForQueue` (it emits `error` and marks the review); the processor deliberately does **not** rethrow to BullMQ, so expensive LLM work is never auto-retried.
4. `finally`: `await conn.flush()` before the job completes — a BullMQ completion must never race the terminal stream append — then `execution.dispose()`.
5. `@OnWorkerEvent('failed')` — if BullMQ itself kills the job (process stall/eviction), the handler forces the review `FAILED` in Postgres and appends a terminal `error` event — unless another terminal transition (e.g. cancellation) already won.

### `RedisService` (Streams primitives)

`src/queue/redis.service.ts`:

- `publisher` — one shared ioredis connection for all non-blocking operations.
- `createConnection()` — isolated connections for blocking operations (a blocking `XREAD` would stall every other command on a shared connection).
- `emitEvent(reviewId, json)` — pipeline: `XADD review:events:<id> MAXLEN ~ 5000 * event <json>` + `EXPIRE 86400` (**24-hour** replay window; the approximate MAXLEN caps memory at ~5,000 events per review).
- `readEvents(conn, reviewId, afterId, blockMs = 15000, count = 100)` — blocking `XREAD … STREAMS review:events:<id> <afterId>`; returns ordered `{ id, message }` entries.

### `createRedisEmitter` (worker-side event factory)

`src/queue/review.emitter.ts` → `{ send, flush, getTrace, startedAt }` — the `SseConnection` interface from `review.sse.ts`.

`send(event)` is synchronous for orchestration ergonomics, but appends are serialized through an internal promise queue; a failure is captured and rethrown by `flush()`. `getTrace()` returns the in-memory copy that `runForQueue` persists as `Review.traceLog`.

### `ReviewStreamerService` (SSE endpoint)

`src/review/review-streamer.service.ts` — `createStream(reviewId, userId, suppliedLastId?)`:

1. Loads the review (ownership enforced via `HistoryService.getReview`).
2. `lastId = suppliedLastId` when it matches the `N-N` stream-id shape (`isStreamId`), else `0-0` (full replay).
3. Loop: `XREAD` after `lastId`; `blockMs = 15s` while the review is live, `0` once the row is terminal (immediate drain — no needless 15-second wait).
4. Each entry is forwarded as an SSE frame with `id: <stream-id>` — the client stores it for resume.
5. After every read the review row is re-loaded; when it reaches a terminal status (`COMPLETE`/`PARTIAL`/`FAILED`/`CANCELLED`) the streamer emits a **reconstructed terminal event** from Postgres (below) and completes the Observable. A streamed `complete`/`error` event also closes the stream.
6. On an **empty** read it emits `{ type: 'heartbeat' }` — keeps proxies/browsers from killing idle connections. Heartbeats are deliberately **not** persisted to the stream (they would pad the replay log with noise).
7. Teardown: unsubscribe sets `stopped` and calls `reader.disconnect()`, interrupting the blocking `XREAD` immediately.

**Postgres is the authority for terminal state.** `reconstructTerminal` builds the final frame from the database, not Redis: `FAILED`/`CANCELLED` → `{ type: 'error', message }`; `COMPLETE`/`PARTIAL` → `{ type: 'complete', review, outcome, … }` with the review parsed through `ReviewDataSchema`. A client that connects even after the 24h stream window expired still receives a correct terminal event.

### `ReviewCancellationService` (cancel + deadlines)

`src/queue/review-cancellation.service.ts`:

- `requestCancellation(reviewId)` (via `DELETE /review/:reviewId` → `ReviewService.cancelReview`) — pipeline `SET review:cancel:<id> 1 EX 600` + `PUBLISH review:cancel:<id> cancel`. The TTL key makes cancellation durable for 10 minutes (a review cancelled before its job starts still aborts); the pub/sub message aborts a running review in milliseconds.
- `createExecution(reviewId, totalMs)` — builds the `AbortSignal`: checks the TTL key, subscribes the channel on an isolated connection, then **double-checks the key** (closing the check/subscribe race), and starts the review-wide deadline timer (`ReviewDeadlineError` after `totalMs`).
- `operationDeadline(parent, operation, timeoutMs)` — per-operation deadlines (e.g. 120s for a model call) composed with the parent signal via `AbortSignal.any`.
- Error taxonomy: `ReviewCancelledError`, `ReviewDeadlineError`, `OperationDeadlineError`; `throwSignalReason` unwraps the abort reason.

- **Retries** — a failed enqueue returns the row to `PENDING` with `availableAt = now + backoff`, delays `[1s, 2s, 4s, 8s, 16s]` — 6 attempts max (`MAX_DISPATCH_ATTEMPTS`).
- **Exhaustion** — after the final attempt, `failExhausted` transitions the dispatch to `FAILED` and (transactionally) the review to `FAILED` with a public message, then appends a terminal `error` event to the stream so any listening client finishes.
- **Boot reconciliation** — `reconcileLegacyPending()` runs at startup: recent (< 5 min) `PENDING` reviews missing a dispatch row get one (`skipDuplicates`); stale ones transition to `FAILED` + terminal event. This rescues rows written before the outbox existed or orphaned by a crash between the two writes' era.

---

## System Flow

```
1. Browser          POST /review/session  { type, input }   (Authorization: Bearer …)
2. ReviewController → ReviewService.createSession
                    tx: INSERT Review(PENDING) + ReviewDispatch(PENDING)
                    → 201 { reviewId }        (+ dispatcher.kick())

3. Browser          GET /review/:id/stream   (Last-Event-ID when resuming)
                    ReviewStreamerService: XREAD from 0-0 (or the supplied id)
                    → replays anything already emitted, then tails live

4. Dispatcher       claims the outbox row (PROCESSING, 30s lease)
                    → QueueService.enqueue({ reviewId, type, input, userId })
                    → dispatch DISPATCHED

5. ReviewProcessor  createExecution(5-min deadline) → createRedisEmitter
                    ReviewService.runForQueue:
                      start → acquisition → task/cluster plans → thinking/tool events
                      → cluster_done / synthesis → complete (or error)
                    every send() → XADD review:events:<id> (MAXLEN ~ 5000, EXPIRE 24h)
                    finally: flush() → dispose()

6. Streamer         forwards each entry as SSE (id: <stream-id>)
                    on streamed complete/error → close
                    when the DB row turns terminal → reconstructed terminal → close

7. Persist          runForQueue persists summary/score/issues/positives/coverage/traceLog
                    to Postgres before the terminal event is emitted
```

---

## Redis Key Schema

| Key | Type | Purpose | TTL / bounds |
|---|---|---|---|
| `review:events:<reviewId>` | Stream | Ordered review events (`event` field = JSON `ReviewStreamEvent`) | `EXPIRE` 24h, refreshed on every append; `MAXLEN ~ 5000` |
| `review:cancel:<reviewId>` | String **and** pub/sub channel | Cancellation: TTL key (durable cancel) + channel (live abort) | 600s |
| `bull:review-jobs:*` | Various | BullMQ queue internals | Managed by BullMQ (completed jobs 1h, failed 3d) |

---

## SSE Protocol (client contract)

- Frames carry `id: <stream-entry-id>`, `event: <event.type>`, and `data: <json>` (the `@Sse` Observable emits `{ id, type, data }` per stream entry).
- **Resume** — the client sends `Last-Event-ID: <last received id>`; the server validates the `N-N` shape (`isStreamId`) and resumes after it; an absent/invalid value starts at `0-0` (full replay). Client reconnect backoff is 500ms → 1000ms → 2000ms with event-id dedupe (`apps/client/lib/use-review-stream.ts`).
- **Heartbeats** — `{ type: 'heartbeat' }` frames keep the connection alive during idle 15s blocking reads; the client skips them (no state change) and they are never persisted to the stream.
- **Terminal guarantee** — exactly one terminal frame (`complete` or `error`) is delivered before the server closes the stream, either streamed from the pipeline or reconstructed from Postgres.

---

## Health & Operations

`GET /health` (unauthenticated) reports dependency status with a **30-second in-memory cache** (`health.controller.ts`):

| Field | Check |
|---|---|
| `status` | `ok` or `degraded` (degraded when any dependency is not `valid`) |
| `database` | `SELECT 1` via Prisma |
| `databaseSchema` | migration-presence probe (`ReviewDispatch` table + `Review.coverage` column) |
| `redis` | `PING` |
| `redisStreams` | `COMMAND INFO XADD` — Redis Streams support |

---

## Responsibilities

| Component | Owns |
|---|---|
| `ReviewRepository` | Atomic Review + ReviewDispatch write |
| `ReviewDispatcherService` | Outbox polling, claiming, leases, backoff, exhaustion, boot reconciliation |
| `QueueService` | BullMQ enqueue/remove, job options |
| `ReviewProcessor` | Worker lifecycle, deadline wiring, flush-before-complete, `onFailed` rescue |
| `RedisService` | Connections, `XADD`/`XREAD` primitives, stream TTL/caps |
| `createRedisEmitter` | `SseConnection`-shaped, serialized stream appends |
| `ReviewStreamerService` | SSE Observable, replay + live tail, heartbeats, terminal reconstruction |
| `ReviewCancellationService` | Cancel key/channel, execution `AbortSignal`, deadlines |

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Client connects after the review completed | Stream drains with `blockMs = 0`; terminal event **reconstructed from Postgres** — works even after the 24h stream TTL |
| Client connects before the job starts | Stream is empty; blocking reads hold the connection; heartbeats every 15s until events arrive |
| Browser drops mid-review | Next connect sends `Last-Event-ID`; replay resumes after that id (client dedupes by id) |
| Redis down mid-review | Emitter captures the append failure; `flush()` rethrows before job completion → job fails → `onFailed` forces `FAILED` + best-effort terminal event |
| Node process restarts mid-job | BullMQ `failed` event → review forced `FAILED` + terminal error event appended |
| Dispatch keeps failing (e.g. Redis down at enqueue) | Backoff 1s→16s across 6 attempts → review `FAILED` + terminal error event |
| Cancel while queued | `removeJob` drops the pending BullMQ job; review → `CANCELLED`; terminal event emitted |
| Cancel mid-run | `review:cancel` key+channel → `AbortSignal` aborts the model call; terminal event emitted; DB marked `CANCELLED` |
| Review exceeds 5 minutes | Deadline abort → `ReviewDeadlineError` → review `FAILED` with a public message |
| Cancel arrives between the existence check and the subscribe | Closed by the post-subscribe double-check of the TTL key |
| Multiple SSE clients for one review | Each gets an independent `XREAD` connection via `createConnection()` — no shared-state coupling |
| SSE client disconnects | Teardown sets `stopped` + `reader.disconnect()` interrupts the blocking read — no leaked connections |
| Server restarts with legacy PENDING rows (pre-outbox) | Boot reconciliation creates dispatch rows for recent ones, fails stale ones with a terminal event |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/queue/queue.service.ts`](../apps/server/src/queue/queue.service.ts) | BullMQ enqueue/remove |
| [`apps/server/src/queue/queue.module.ts`](../apps/server/src/queue/queue.module.ts) | BullMQ + Redis module wiring |
| [`apps/server/src/queue/redis.service.ts`](../apps/server/src/queue/redis.service.ts) | ioredis connections, `emitEvent` (`XADD`), `readEvents` (`XREAD`) |
| [`apps/server/src/queue/review.emitter.ts`](../apps/server/src/queue/review.emitter.ts) | Stream-backed `SseConnection` factory |
| [`apps/server/src/queue/review-cancellation.service.ts`](../apps/server/src/queue/review-cancellation.service.ts) | Cancellation + deadlines |
| [`apps/server/src/review/review-dispatcher.service.ts`](../apps/server/src/review/review-dispatcher.service.ts) | Outbox dispatcher |
| [`apps/server/src/review/review.processor.ts`](../apps/server/src/review/review.processor.ts) | BullMQ worker |
| [`apps/server/src/review/review-streamer.service.ts`](../apps/server/src/review/review-streamer.service.ts) | Client SSE Observable (replay + tail + terminal reconstruction) |
| [`apps/server/src/review/review.sse.ts`](../apps/server/src/review/review.sse.ts) | `SseConnection` interface |
| [`apps/server/src/review/review.controller.ts`](../apps/server/src/review/review.controller.ts) | `POST /review/session`, `GET /review/:id/stream`, `DELETE /review/:id` |
| [`apps/server/src/health.controller.ts`](../apps/server/src/health.controller.ts) | `/health` dependency probes |
| [`apps/client/lib/use-review-stream.ts`](../apps/client/lib/use-review-stream.ts) | Client SSE consumer (resume, backoff, dedupe, heartbeat skip) |
| [`apps/client/lib/sse.ts`](../apps/client/lib/sse.ts) | SSE frame parser (multiline `data:`, `id:` capture, CRLF, comments) |

| `githubToken` | server PAT validity (`GithubService.getTokenHealth()`) |

Each dependency reads `valid` / `invalid` / `unchecked`. The client also polls `/health` for its server-wakeup UX (Render free-tier cold starts).

