# 005 — Streamer polls terminal state with a status-only query

- **Status:** Accepted & implemented (2026-08-12)
- **Audit finding:** S-11

## Context

`ReviewStreamerService` reloaded the **full** review row — including all issues
and conversations — on every 15-second blocking-read cycle (and on every XREAD
error path) purely to check the status. For large reviews that is wasteful on
every connected SSE client.

## Options

- **(a)** Status-only query for the poll; full load only when needed.
- **(b)** Document and leave as-is.

## Decision

**(a) — implemented.** `HistoryRepository.getReviewStatus(id, userId)` selects
only `status` (still scoped by `userId`, so ownership filtering is preserved).
The streamer does one full `getReview` up front (ownership check + initial
status), polls with the status-only query, and loads the full row only when a
terminal state must be reconstructed for the client.

## Consequences

- Per-poll query cost drops to one indexed column instead of a 3-table join.
- Behavior change: a review deleted mid-stream now closes the stream quietly
  (previously the reload threw `NotFoundException` and errored the stream).
- Covered by `review-streamer.service.spec.ts` (status-only poll spec:
  `getReview` called exactly twice — initial + reconstruction).

## Links

- `apps/server/src/review/review-streamer.service.ts`,
  `apps/server/src/history/history.repository.ts`
