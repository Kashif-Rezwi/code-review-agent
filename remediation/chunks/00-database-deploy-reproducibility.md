# Chunk 00 — Database & deploy reproducibility

> **Status:** pending · **Findings:** M-1, M-2, M-7, E-3, M-9 (5) · **Severity mix:** 🔴1 🟠1 🟡3
> **Depends on:** none · **Gated by:** **Q1** (baseline-reconciliation strategy for the live Neon DB — get the human's answer before touching migrations)
> **Files touched:** `apps/server/prisma/migrations/**`, `apps/server/prisma/schema.prisma` (indexes only), `render.yaml`, `docker-compose.yml`, `README.md` (one note), `docs/deployment.md` (one note), `remediation/PROGRESS.md`

## 1. Goal & why it matters

Make the project provisionable from scratch. Today `prisma migrate deploy` **fails on any empty database** (migration #2 alters an enum that no migration creates), and the Render blueprint never wires `DATABASE_URL`. Every new contributor clone and every new environment is broken by default. This is the only 🔴 runtime defect in the audit — it outranks all documentation work.

## 2. Context brief (ground truth)

- `apps/server/prisma/migrations/` has 4 migrations: `20260312092706_week4_rag` (creates **only** `Document`, `DocumentChunk` + one FK), `20260417214551_add_cancelled_status` (`ALTER TYPE "ReviewStatus" ADD VALUE 'CANCELLED'`), `20260718090000_add_partial_review_coverage` (`ADD VALUE 'PARTIAL'` + `Review.coverage` JSONB), `20260718170000_add_review_dispatch_outbox` (creates `DispatchStatus` enum + `ReviewDispatch` table + its 2 indexes + FK to `Review(id)`).
- **No migration creates** `User`, `Review`, `Issue`, `Conversation`, `ReviewStatus`, or `ReviewType`. The live Neon DB was provisioned out-of-band (almost certainly `prisma db push`).
- Full current schema: `apps/server/prisma/schema.prisma` — 7 models (`User`, `Document`, `DocumentChunk`, `Review`, `ReviewDispatch`, `Issue`, `Conversation`), 3 enums. Datasource: `env("DATABASE_URL")` + `directUrl = env("DIRECT_URL")`, pgvector extension.
- Indexes today: only `ReviewDispatch_reviewId_key` (unique) + `ReviewDispatch_status_availableAt_idx`. Nothing on `Review.userId` (hot: `listReviews`/`getStats` filter by it), `Issue.reviewId`, `Conversation.reviewId`, `Document.userId`, `DocumentChunk.documentId`.
- `render.yaml` envVars: `NODE_ENV`, `PORT`, `FRONTEND_URL`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `REDIS_URL` (from the Redis service). No `DATABASE_URL`/`DIRECT_URL`, not even `sync: false` placeholders. Also `branch: main` while active development is on `develop` (E-3).
- `docker-compose.yml` runs Redis + server + client but **no Postgres service** and nothing runs migrations — compose alone cannot produce a working system (M-9 sub-item).
- `PrismaService.onModuleInit()` does `await this.$connect()` with no catch — boot dies if DB is unreachable (S-2; direction decided in chunk 09, **not** changed here).

## 3. Findings covered

| ID | Sev | Finding |
|---|---|---|
| M-1 | 🔴 | No baseline migration — fresh `prisma migrate deploy` fails at migration #2 (`ALTER TYPE "ReviewStatus"` before the type exists; `ReviewDispatch` FK references a `Review` table no migration creates) |
| M-2 | 🟠 | `render.yaml` never wires `DATABASE_URL`/`DIRECT_URL` — fresh Render deploy crash-loops (with S-2 + M-1) |
| M-7 | 🟡 | No indexes on `Review.userId`, `Issue.reviewId`, `Conversation.reviewId`, `Document.userId`, `DocumentChunk.documentId` |
| E-3 | 🟡 | `render.yaml` pins `branch: main`, development happens on `develop`; docs say "push to main" — needs an explicit note |
| M-9 | 🟡 | (compose sub-item only) No Postgres service / no migration step in `docker-compose.yml` |

## 4. Read first

- `apps/server/prisma/schema.prisma` and all 4 files in `apps/server/prisma/migrations/`
- `render.yaml`, `docker-compose.yml`
- `AUDIT-REPORT.md` §8 (M-1, M-2, M-7), §7 (E-3)
- Prisma docs: `migrate diff`, `migrate resolve` (baselining an existing database)

## 5. Tasks

1. [ ] **Q1 decision — record it.** Ask the human: reconcile the live Neon DB via (A) **prepend baseline** (new earlier-timestamp migration creating the missing tables/enums as they existed pre-`20260417`; existing envs run `prisma migrate resolve --applied <baseline>` once) or (B) **squash** (delete all 4 migrations, one baseline from empty→current schema; existing envs resolve/marked). Recommended: **A** — preserves history, standard Prisma baselining. Record the choice here: **DECISION: ____**
2. [ ] **Create the baseline migration** per the chosen option. For A: DDL for `User`, `Review` (pre-`coverage`; enum `ReviewStatus` with only `PENDING`/`COMPLETE`/`FAILED`), `Issue`, `Conversation`, `ReviewType` — via `prisma migrate diff --from-empty --to-schema-datamodel` against a reconstructed intermediate schema, or hand-written DDL. Timestamp must precede `20260312092706` (e.g. `20260301000000_baseline_core`). **Acceptance:** `migrate deploy` on a **completely empty** Postgres (docker `pgvector/pgvector:pg16`) runs all 5 migrations to completion, and `migrate diff --from-migrations --to-schema-datamodel` shows no diff.
3. [ ] **Reconcile existing databases.** Execute/document `prisma migrate resolve --applied 20260301000000_baseline_core` on the live Neon DB. **Acceptance:** `prisma migrate status` on the live DB = up to date, no failed/pending entries.
4. [ ] **M-7 indexes — separate NEW migration** (must also reach existing DBs, so it cannot live inside the baseline): add `@@index([userId])` to `Review` and `Document`; add indexes on `Issue.reviewId`, `Conversation.reviewId`, `DocumentChunk.documentId`; generate via `migrate dev`. **Acceptance:** applies cleanly on the reconciled live DB.
5. [ ] **M-2: `render.yaml`** — add `DATABASE_URL` and `DIRECT_URL` as `sync: false` env vars. **Acceptance:** both keys present in the blueprint.
6. [ ] **E-3: branch note** — switch `branch:` to the human's intended deploy branch, or keep `main` and add a code comment + one line in `docs/deployment.md` stating deploys happen only from `main`.
7. [ ] **M-9 compose note** — add a comment in `docker-compose.yml` + one line in `README.md` §Docker Compose: compose expects an external Postgres (`DATABASE_URL` in `apps/server/.env`); run migrations manually (`npx prisma migrate deploy`). Do **not** add a Postgres service (pgvector requirement makes it heavier than the fix is worth — note that trade-off in the comment).

## 6. Verification

```bash
docker run --rm -d --name cra-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 pgvector/pgvector:pg16
cd apps/server
DATABASE_URL="postgresql://postgres:pg@localhost:55432/postgres" \
DIRECT_URL="postgresql://postgres:pg@localhost:55432/postgres" \
  npx prisma migrate deploy          # must succeed end-to-end on the empty DB
DATABASE_URL="postgresql://postgres:pg@localhost:55432/postgres" \
  npx prisma migrate diff --from-migrations --to-schema-datamodel prisma/schema.prisma   # no diff
docker rm -f cra-pg
pnpm build:packages && pnpm type-check && pnpm --filter server test   # still green
```

## 7. Guardrails

- **Never edit the 4 existing migration files** — they may be applied in prod. New files only (the baseline gets an *earlier* timestamp; that is safe because it never ran anywhere).
- Do not change `schema.prisma` models except the M-7 `@@index` lines.
- Do not attempt S-2 (boot behavior) here — chunk 09 decides its direction.
- Verify against a REAL empty Postgres container — a diff-only check is not sufficient.

## 8. Done checklist

- [ ] Q1 decision recorded in this file
- [ ] Fresh-DB `migrate deploy` passes; schema diff empty
- [ ] Live DB reconciled; `migrate status` clean
- [ ] Index migration created + applied
- [ ] `render.yaml` has `DATABASE_URL`/`DIRECT_URL`; branch note resolved
- [ ] Compose/README note added
- [ ] `PROGRESS.md` updated (5 findings)
