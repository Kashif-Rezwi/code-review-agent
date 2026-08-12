# Chunk 03 — Docs: streaming & architecture rewrite

> **Status:** pending · **Findings:** A-1…A-9, A-10, B-1, B-2, B-3, B-4, B-6, A-37 (16) · **Severity mix:** 🔴6 🟠8 🟡2
> **Depends on:** chunks 01, 02, 07, 08 (docs must describe the fixed code) · **Gated by:** nothing
> **Files touched:** `docs/queue-streaming.md` (full rewrite), `docs/architecture.md`, `README.md` (diagram + tech-stack + module list), `remediation/PROGRESS.md`. **Shares `README.md` with chunk 06 — never run 03 and 06 concurrently.**

## 1. Goal & why it matters

`docs/queue-streaming.md` describes a **deleted architecture** end-to-end (Redis List replay + Pub/Sub); the system actually runs on Redis Streams with an outbox dispatcher, cancellation, heartbeats, and `Last-Event-ID` resume — none of which are documented anywhere. Anyone (human or agent) reading today's doc learns a system that does not exist. This is the audit's largest documentation gap.

## 2. Context brief (ground truth — the REAL design to document)

**Queue & dispatch (outbox):**
- `POST /review/session` → `ReviewRepository.createSession` (`review.repository.ts:20-36`): one transaction creates `Review` (PENDING) + `ReviewDispatch` rows. No direct BullMQ call in the controller path.
- `ReviewDispatcherService` (`review-dispatcher.service.ts`): `setInterval` poll every **2s** (`POLL_INTERVAL_MS`), batch **20**, claims via conditional `updateMany` with **30s leases** (`LEASE_MS`), retries with backoff `[1,2,4,8,16]s` — **6 attempts** max; `reconcileLegacyPending()` at boot (5-min cutoff: recent PENDING rows w/o dispatch get one; stale ones → FAILED + terminal event); `failExhausted` transitions Review → FAILED + emits terminal error event.
- `QueueService`: `enqueue` (jobId = reviewId, `attempts: 1`, `removeOnComplete: { age: 3600 }`, `removeOnFail: { age: 3d }`, dedupe via `getJob`); `removeJob` for cancellation.

**Event transport (Redis Streams):**
- `RedisService` (`queue/redis.service.ts`): `publisher` + `createConnection()` (isolated blocking-read connections). `emitEvent` = pipeline `XADD review:events:<id> MAXLEN ~ 5000 * event <json>` + `EXPIRE 86400` (**24h**). `readEvents(conn, reviewId, afterId, blockMs=15000, count=100)` = blocking `XREAD`. Keys: `review:events:<id>` (stream) and `review:cancel:<id>` (TTL key **and** pub/sub channel — the only remaining pub/sub).
- `createRedisEmitter(redis, reviewId)` (`queue/review.emitter.ts`) → `{ send, flush, getTrace, startedAt }`; `send` is sync-ergonomic with a serialized internal append queue; `flush()` is awaited before BullMQ completion so a completion never races the terminal append.

**SSE streaming:**
- `ReviewStreamerService.createStream(reviewId, userId, suppliedLastId?)` (`review/review-streamer.service.ts`): validates `suppliedLastId` with `isStreamId` else starts at `0-0`; loop: `blockMs = 0` when the review row is terminal else 15 000; emits SSE `id:` per stream entry; after each read re-loads the review row and, if terminal (COMPLETE/PARTIAL/FAILED/CANCELLED), emits a **full reconstructed terminal event** (`reconstructTerminal` — COMPLETE/PARTIAL → `complete` w/ full `ReviewData` parsed through `ReviewDataSchema`; FAILED/CANCELLED → `error`); on an empty read emits `{ type: 'heartbeat' }` (**not persisted** to the stream, intentionally); teardown (`unsubscribe`) sets `stopped` + `reader.disconnect()` to interrupt the blocking XREAD.
- Controller (`review.controller.ts`): `GET /review/:reviewId/stream` reads the `Last-Event-ID` header; `DELETE /review/:reviewId` (204) cancels.
- Client (`apps/client/lib/use-review-stream.ts`): fetch-based SSE, sends `Last-Event-ID` when resuming, reconnect backoff `[500, 1000, 2000]`, dedupes by event id, skips heartbeats. `lib/sse.ts` is a full frame parser (multiline `data:`, `id:` capture, CRLF, comments).

**Cancellation & deadlines:**
- `ReviewCancellationService` (`queue/review-cancellation.service.ts`): `requestCancellation` = pipeline `SET review:cancel:<id> 1 EX 600` + `PUBLISH review:cancel:<id> cancel`. `createExecution(reviewId, totalMs)` → `{ signal, dispose }`: checks the key, subscribes, re-checks (closes check/subscribe race), and arms a deadline timer — **5 min** per review (`review.processor.ts:64`, `5 * 60_000`); `operationDeadline(parent, op, ms)` composes per-operation deadlines via `AbortSignal.any`.
- `ReviewService.cancelReview` (`review.service.ts:98-121`): `markCancelled` (PENDING→CANCELLED + dispatch row) → `removeJob` + `requestCancellation` (allSettled) → terminal `error` event only if the transition won (never double-terminates).
- `ReviewProcessor` (`review.processor.ts`): `@Processor('review-jobs')`; on job failure (`onFailed`) → `markFailed` + terminal event; `process` wraps `runForQueue` in a 5-min execution and always `flush()`es the emitter before disposing.

**Health:** `health.controller.ts` — `GET /health` returns `{ status, database, databaseSchema, redis, redisStreams, githubToken }`; dependency results cached 30s; any invalid ⇒ `status: 'degraded'`.

## 3. Findings covered

| IDs | What to fix |
|---|---|
| A-1, A-2, A-3 🔴 | Replay/pub-sub claims (`rl:`, `re:`, RPUSH/PUBLISH, 1h TTL, `createSubscriber`/`getLog`) — replace with the Streams design above |
| A-4, A-5, A-6, A-7, A-8, A-9 🟠 | emitter signature + `flush` semantics, `removeJob`, XREAD loop/teardown/terminal reconstruction, `Last-Event-ID` resume, heartbeats, cancellation |
| A-10 🔴 | architecture.md data-stores table (Streams 24h/MAXLEN; cancel key) |
| B-1/B-2 🔴 | Document the dispatch outbox + cancellation subsystems (new queue-streaming.md sections) |
| B-3/B-4 🟠 | heartbeat event; `Last-Event-ID` resume |
| B-6 🟡 | `/health` dependency checks + 30s cache |
| A-37 🟡 | README: Redis tech-stack line, architecture diagram, github module description |

## 4. Read first

- Code truth: `apps/server/src/queue/redis.service.ts`, `queue/review.emitter.ts`, `queue/queue.service.ts`, `queue/review-cancellation.service.ts`, `review/review-dispatcher.service.ts`, `review/review-streamer.service.ts`, `review/review.processor.ts`, `review/review.controller.ts`, `review/review.service.ts:79-148`, `apps/server/src/health.controller.ts`, `apps/client/lib/use-review-stream.ts`, `apps/client/lib/sse.ts`
- `packages/types/src/index.ts` — the `ReviewStreamEvent` union (14 members incl. `heartbeat`)
- The current (stale) `docs/queue-streaming.md`, `docs/architecture.md`, `README.md`
- `AUDIT-REPORT.md` §2.1, §2.2, §3

## 5. Tasks

1. [ ] **Rewrite `docs/queue-streaming.md`** around the real design: session creation → outbox row → dispatcher poll/claim/lease/backoff/reconcile/exhaustion → BullMQ enqueue (jobId = reviewId, attempts 1) → processor + 5-min execution → Redis Streams emission (`XADD`/`MAXLEN ~5000`/24h TTL) → streamer `XREAD` loop → SSE. Include: Redis key table (`review:events:<id>` stream 24h; `review:cancel:<id>` TTL 600s + channel), heartbeats (not persisted, why), `Last-Event-ID` resume (server `isStreamId` validation + client backoff `[500,1000,2000]` + id dedupe), terminal-state reconstruction from Postgres (authoritative over Redis), cancellation flow (TTL key + pub/sub + AbortSignal + race-closing double-check), and the edge-case table (Redis down mid-review, browser reconnect, cancel-during-run, worker crash → `onFailed` rescue, dispatch exhaustion). **Acceptance:** every mechanism named in this brief appears in the doc; zero references to `rl:`/`re:`/`RPUSH`/`PUBLISH`/`createSubscriber`/`getLog` remain.
2. [ ] **Fix `docs/architecture.md`** data-stores table (A-10) and any streaming-sequence description to match; note the outbox + cancellation as first-class components.
3. [ ] **Fix `README.md`** (A-37): tech-stack Redis line ("BullMQ jobs + Redis Streams event log + cancellation channel"), the ASCII diagram ("Redis pub/sub │ replay list" → Streams), the streamer caption, and the github-module description ("diff, files, file content" → snapshot acquisition; the file-content API is gone). **Acceptance:** grep README for `pub/sub`/`replay list` → no stale hits (the cancellation channel mention is fine).
4. [ ] **B-6:** document `/health` dependency fields + 30s cache (fits naturally in the new queue-streaming.md ops section or architecture.md).

## 6. Verification

```bash
grep -n 'rl:\|re:<\|RPUSH\|PUBLISH re:\|createSubscriber\|getLog\|replay list' docs/queue-streaming.md docs/architecture.md README.md   # expect: no matches
grep -n 'review:events\|Last-Event-ID\|heartbeat\|ReviewDispatch\|MAXLEN\|86400\|XREAD\|XADD' docs/queue-streaming.md                        # expect: multiple matches
```

## 7. Guardrails

- Documentation only — no code edits in this chunk.
- Do not invent behavior: every claim must trace to a file listed in §2. When unsure, re-read the code.
- Keep the doc's existing structure/tone where salvageable; rewrite sections, don't pad.
- If chunk 01/02 changed any behavior described here, describe the NEW behavior.

## 8. Done checklist

- [ ] queue-streaming.md rewritten (Streams + outbox + cancellation + resume + heartbeats)
- [ ] architecture.md data-stores + components fixed
- [ ] README diagram/stack/module list fixed
- [ ] `/health` documented
- [ ] Grep checks pass; `PROGRESS.md` updated (16 findings)
