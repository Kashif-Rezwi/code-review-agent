# 002 — BullMQ worker concurrency = 1 is a deliberate cost cap

- **Status:** Accepted (documented, 2026-08-12)
- **Audit finding:** M-4 · **Open question:** Q4

## Context

`@Processor('review-jobs')` sets no `concurrency`, so BullMQ runs one job at a
time per instance (~12 reviews/hour ceiling with the 5-minute deadline; five
concurrent users could wait ~25 minutes). The audit flagged this as an
undocumented, unexamined decision. Note: `WORKER_CONCURRENCY = 3` in
`review.service.ts` is *intra-review* parallelism (worker agents within one PR
review) and is unaffected by the queue-level setting.

## Options

- **(a) Document concurrency = 1 as deliberate** (cost safety) and raise only
  when real usage demands it.
- **(b) Raise now** (e.g. `concurrency: 2-3`) with an OpenAI-spend note.

## Decision

**(a) document as deliberate.** Every job spends real money (≤10 gpt-4o-mini
steps + embeddings); serial execution is the hard ceiling on burn rate. The
chunk-02 rate limiting (10 reviews/hour per user) already bounds per-user
demand, and there is no measured queueing pain to justify more parallelism.

## Consequences

- No code change; the intent is recorded here and in `docs/queue-streaming.md`.
- Revisit when throughput complaints or metrics show queue wait dominating
  review latency.

## Links

- `apps/server/src/review/review.processor.ts`, `apps/server/src/queue/queue.module.ts`
