# Chunk 09 — Deferred decision records (ADRs)

> **Status:** done (2026-08-12) · **Findings:** S-2, M-4, S-6, S-10, S-11, M-10 (6) · **Severity mix:** 🟠2 🟡4
>
> **DECISIONS (2026-08-12, repo owner delegated to executor's recommendations):** **Q7/S-2 = (a) resilient boot** — `PrismaService` catches `$connect` failure, logs, boots degraded (activates the existing `/health` degraded design; Neon free-tier wake latency is routine). **Q4/M-4 = (a)** concurrency 1 documented as deliberate cost cap. **S-6 = (a) implemented** — `@typescript-eslint/parser` behind the `language` arg + ambient globals fix for `no-undef`. **S-10 = (b)** documented debt. **S-11 = (a) implemented** — status-only poll. **M-10 = (a)** watch-item.
> **Depends on:** none (can run anytime) · **Gated by:** **Q4** (worker-concurrency intent), **Q7** (S-2 direction)
> **Files touched:** `remediation/decisions/*.md` (new ADRs), `docs/` one-liners where a decision changes a documented claim, `remediation/PROGRESS.md`. **Code changes only where a decision explicitly says "implement".**

## 1. Goal & why it matters

Six findings are policy decisions disguised as bugs. Writing code before deciding wastes effort; leaving them undecided lets them silently rot. This chunk records an ADR per finding (context → options → decision → consequences) and implements only the trivially-safe outcomes the human approves.

## 2. The decisions

| ID | Question | Options | Recommendation |
|---|---|---|---|
| S-2 | DB-less boot? | (a) Resilient boot: catch `$connect()` failure, log, continue degraded (matches existing `/health` degraded design + rag.md's "dev mode without DB" promise) · (b) Keep fail-fast boot; delete the dead `hasDb` guards in `RagService`/`RagRepository`/`ReviewRepository` + fix rag.md claims | **(a)** if the app should stay up during transient Neon outages; **(b)** is the cheaper correct option |
| M-4 | BullMQ worker concurrency = 1 — intentional cost cap? | (a) Document as deliberate (cost safety; ~12 reviews/hr/instance) · (b) Raise (e.g. `@Processor('review-jobs', { concurrency: 2-3 })`) with an OpenAI-spend note | **(a) document now**; raise only when real usage demands it |
| S-6 | TS-aware linting? | (a) Wire `@typescript-eslint/parser` in `LinterService` using the `language` arg · (b) Document JS-only limitation (chunk 04 already writes the limitation line; flip it if (a)) | **(a)** — pasted-code review is a core flow and TS pastes are common; moderate effort |
| S-10 | Chat history windowing? | (a) Cap conversation context (e.g. last N turns + token estimate) · (b) Document as known debt | **(b) now**, (a) when long threads prove costly |
| S-11 | Full-review reload every 15s poll? | (a) Status-only query for the streamer's terminal check (`select: { status }`), full load only for reconstruction · (b) Document | **(a)** — small, safe, real query savings per connected SSE client |
| M-10 | `ReviewService` ~940 lines? | (a) Watch-item only (recorded) · (b) Extract orchestration helpers | **(a)** — explicitly NOT a refactoring mandate; revisit only when the file next needs a feature change |

## 3. Tasks

1. [x] Get the human's answers for Q4 and Q7 (and confirm the recommendations above for S-6/S-10/S-11/M-10).
2. [x] Write `remediation/decisions/NNN-<slug>.md` per finding (template: Context / Options / Decision / Consequences / Links to audit ID).
3. [x] Implement approved outcomes: S-11(a) status-only query (guard: keep `getReview`'s ownership check — the status query must still filter by `userId`); S-6(a) parser wiring **only if approved**; S-2 per Q7.
4. [x] Update affected docs (`docs/rag.md` for S-2; `docs/review-code.md` for S-6 if implemented; `docs/queue-streaming.md` for M-4/S-11 notes) — coordinate with chunks 03/04/05 if in flight.
5. [x] Close each finding in PROGRESS.md with the ADR link.

## 4. Verification

```bash
pnpm build:packages && pnpm type-check
pnpm --filter server test     # add a spec for the S-11 status-only path if implemented
```

## 5. Guardrails

- An ADR with "document" as its decision is a complete resolution — do not gold-plate.
- S-11: the streamer calls `historyService.getReview(reviewId, userId)` both for the terminal check and reconstruction; only the *polling* call becomes status-only. Ownership filtering must be preserved in both.
- M-10: no "while I'm here" extraction of `ReviewService`.

## 6. Done checklist

- [x] 6 ADRs written, decisions recorded with the human's answers
- [x] Approved implementations landed + tested
- [x] Docs updated where decisions changed claims
- [x] `PROGRESS.md` updated (6 findings) — **all 80 findings now resolved or recorded**
