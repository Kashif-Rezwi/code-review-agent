# 001 — Resilient boot without a reachable database

- **Status:** Accepted & implemented (2026-08-12)
- **Audit finding:** S-2 · **Open question:** Q7

## Context

`PrismaService.onModuleInit()` called `$connect()` with no error handling, so the
server could not boot without a reachable `DATABASE_URL` — a transient Neon
outage (or free-tier wake latency) at deploy time crash-looped the API. The
codebase already invested in degraded-mode design: `/health` reports
per-dependency status, the client has a server-wakeup banner, and
`RagService`/`RagRepository`/`ReviewRepository` contain `hasDb` guards that were
unreachable dead paths because boot died first. `docs/rag.md` also promised a
"dev mode without DB" that did not exist.

## Options

- **(a) Resilient boot** — catch the `$connect()` failure, log it, continue
  booting in degraded mode.
- **(b) Keep fail-fast boot** — delete the dead `hasDb` guards and fix the
  rag.md claim.

## Decision

**(a) resilient boot.** It activates the already-built degraded-health design
with a ~10-line change, and on Neon free tier wake latency is routine — a
fail-fast boot would crash-loop exactly when the app should be recovering.

## Consequences

- `PrismaService.onModuleInit` catches connect failures, logs, and continues;
  Prisma reconnects lazily on later queries, so the outage self-heals.
- `/health` reports `database: invalid` → `status: degraded` during an outage
  instead of being unreachable.
- The `hasDb` guards become live, meaningful paths (kept, not deleted).
- Without a DB, review creation fails with a clear 500 message and RAG
  retrieval is bypassed — degraded but honest.
- rag.md's "dev mode without DB" claim is now true.

## Links

- `apps/server/src/prisma/prisma.service.ts`, `apps/server/src/health.controller.ts`
