# Chunk 08 — Hygiene: dead deps, dead code & CI

> **Status:** pending · **Findings:** M-5, M-6, M-8, C-3, S-9, E-1, E-2, E-4, E-5, E-6, E-7, E-8 (12) · **Severity mix:** 🟠3 🟡9
> **Depends on:** chunks 00 (CI's migrate-deploy smoke step needs the baseline), 01 (dead DTO deletion overlaps S-9's dead-code sweep — 01 owns the DTOs, this chunk owns the rest) · **Gated by:** **Q6** (Stripe/Groq/Helicone: label vs. drop — affects E-6 wording)
> **Files touched:** `apps/server/package.json`, `apps/client/package.json`, `apps/client/Dockerfile`, `pnpm-lock.yaml`, `apps/server/src/review/review.sse.ts`, `packages/types/src/index.ts` (comment), `apps/server/src/main.ts`, `apps/server/test/` (delete scaffold), `apps/server/.env.example`, `apps/client/.env.example`, `vercel.example.json` (delete), `docker-compose.yml`, `.github/workflows/ci.yml` (new), `remediation/PROGRESS.md`

## 1. Goal & why it matters

Remove verified-dead weight (4 server deps, 1 git-pinned client dep that forces `apk add git` in Docker, dead functions/files), defuse the e2e landmine *before* it reaches CI, add graceful shutdown, then **lock in the green baseline with CI — last**, so the pipeline never institutionalizes broken artifacts.

## 2. Context brief (ground truth)

- **Dead server deps (M-5):** `@bull-board/api`, `@bull-board/express`, `@bull-board/nestjs`, `openai` — zero imports (grep-verified across `apps/server/src` + `packages/`). `@swc/*` are **load-bearing** (`nest-cli.json` uses the swc builder) — do not touch.
- **Dead client dep (C-3):** `@nanostores/react` is git-pinned (`git+https://github.com/ai/react.git`) with zero imports; it forces `apk add --no-cache git` in `apps/client/Dockerfile` (:18-20).
- **Dead code (S-9):** `initSse()` in `apps/server/src/review/review.sse.ts` has zero references (transport moved to `@Sse` + Redis Streams) — but the `SseConnection` interface in the same file IS used (`review.service.ts:29`, `review.processor.ts` via `createRedisEmitter`): delete only the function. Stale comment in `packages/types/src/index.ts:43-44` references removed endpoints `/review/[analyze|from-pr]/stream`. (The two dead DTOs are deleted in chunk 01.)
- **E2E landmine (M-6):** `apps/server/test/app.e2e-spec.ts` asserts `GET / → 'Hello World!'`; no such route exists (`AppModule` registers only `HealthController`), and booting `AppModule` needs live Redis+DB. Also `test/jest-e2e.json` and the `test:e2e` script.
- **Shutdown (M-8):** `main.ts` lacks `app.enableShutdownHooks()` — SIGTERM skips `onModuleDestroy` (Prisma `$disconnect`, Redis `quit`, BullMQ worker close).
- **Lint scripts (E-2):** server `lint` = `eslint … --fix` (mutates). Client `lint` = bare `eslint` (safe).
- **Env examples (E-6):** `apps/server/.env.example` advertises `GROQ_API_KEY`, `HELICONE_API_KEY`, `STRIPE_*`, JWT vars under misleading headers (incl. `GITHUB_CLIENT_ID/SECRET` under "server-side"); client's lists `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
- Misc: `vercel.example.json` (legacy v2 config, delete — E-5); `.pnpm-store/` empty dir (delete — E-8); server `start`/`start:dev` use `lsof -ti:4000 | xargs kill -9` (macOS-only — E-4); compose client healthcheck `wget http://localhost:3000` follows the auth redirect — point it at `/login` which returns 200 (E-7).
- **CI (E-1):** nothing exists. Must include: pnpm install → build packages → type-check → lint (no `--fix`) → server jest + client vitest → **`prisma migrate deploy` smoke against an ephemeral Postgres service** (locks in chunk 00 forever).

## 3. Findings covered

| IDs | What to do |
|---|---|
| M-5 🟠, C-3 🟡 | Remove 5 dead deps (+ Docker git install); reinstall; lockfile updates |
| M-6 🟡 | Delete scaffold e2e spec + `jest-e2e.json` + `test:e2e` script (real e2e later — note in PROGRESS.md) |
| M-8 🟡 | `app.enableShutdownHooks()` in `main.ts` |
| S-9 🟡 | Delete `initSse` (keep `SseConnection`); fix `@cra/types` comment |
| E-2 🟠 | Split server lint: `lint` (no fix) + `lint:fix` |
| E-1 🟠 | Add `.github/workflows/ci.yml` per §2 (migrate smoke included) |
| E-4 🟡 | Replace `lsof kill` with a cross-platform guard or remove it |
| E-5, E-8 🟡 | Delete `vercel.example.json`, `.pnpm-store/` |
| E-6 🟡 | Label/drop inert env keys per Q6 |
| E-7 🟡 | Compose client healthcheck → `/login` |

## 4. Read first

- `apps/server/package.json`, `apps/client/package.json`, `apps/client/Dockerfile`, `apps/server/nest-cli.json` (swc proof)
- `apps/server/src/review/review.sse.ts`, `packages/types/src/index.ts:43-44`, `apps/server/test/`, `apps/server/src/main.ts`
- `apps/server/.env.example`, `apps/client/.env.example`, `docker-compose.yml`, `vercel.example.json`
- `AUDIT-REPORT.md` §4 (S-9), §7 (E-1…E-8), §8 (M-5, M-6, M-8)

## 5. Tasks (in order — CI last)

1. [ ] **Dead deps (M-5, C-3):** `pnpm --filter server remove @bull-board/api @bull-board/express @bull-board/nestjs openai` and `pnpm --filter client remove @nanostores/react`; delete the `apk add git` lines + comment in `apps/client/Dockerfile`. **Acceptance:** `pnpm install` clean; builds + all tests green; grep confirms no imports.
2. [ ] **Dead code (S-9):** delete `initSse()` from `review.sse.ts` (keep `SseConnection`); fix the stale `@cra/types` comment to reference the real stream endpoint (`GET /review/:id/stream`). (DTO deletion lives in chunk 01 — skip here.)
3. [ ] **M-6:** delete `apps/server/test/app.e2e-spec.ts`, `test/jest-e2e.json`, and the `test:e2e` script. Note "real e2e with services — future" in PROGRESS.md.
4. [ ] **M-8:** add `app.enableShutdownHooks()` in `main.ts` (before `listen`).
5. [ ] **E-2:** server `package.json` — `lint` (no `--fix`) + `lint:fix` (with `--fix`); verify root `pnpm lint` no longer mutates.
6. [ ] **E-4:** replace the `lsof -ti:4000 | xargs kill -9` prefix in `start`/`start:dev` with a portable alternative or drop it (dev convenience only).
7. [ ] **E-5 / E-8:** delete `vercel.example.json` and the empty `.pnpm-store/` directory.
8. [ ] **E-6 (per Q6):** in both `.env.example` files, either drop `GROQ_API_KEY`/`HELICONE_API_KEY`/`STRIPE_*`/`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` or group them under a `# ── Not implemented (reserved) ──` header; fix the server's "GitHub (server-side…)" header for the client-only OAuth vars; JWT vars keep their existing "legacy" note.
9. [ ] **E-7:** compose client healthcheck → `wget -qO- http://localhost:3000/login`.
10. [ ] **E-1 — CI, last:** `.github/workflows/ci.yml` — on push/PR: pnpm + cache → `pnpm install --frozen-lockfile` → `pnpm build:packages` → `pnpm type-check` → lint (no fix) → `pnpm --filter server test` + `pnpm --filter client test` → **migration smoke**: `services: postgres` (pgvector image) + `prisma migrate deploy` + `migrate diff --from-migrations --to-schema-datamodel` empty check. **Acceptance:** workflow runs green on the PR that adds it.

## 6. Verification

```bash
pnpm install && pnpm build:packages && pnpm build        # full build, incl. Docker-free client/server compile
pnpm type-check && pnpm lint                             # root lint now non-mutating — confirm git status clean after
pnpm --filter server test && pnpm --filter client test   # green
git status --short                                       # only intended changes; no lint-mutation drift
docker build -f apps/client/Dockerfile .                 # optional but recommended: proves the git-less client image builds
```

## 7. Guardrails

- Remove ONLY the listed deps — `@swc/*`, `ts-loader`, `parse-diff`, `pdf-parse` are all load-bearing (verified).
- CI must run lint **without** `--fix`.
- Do not write a replacement e2e suite in this chunk — deletion + CI only.
- Keep `test:watch`/`test:cov`/`test:debug` scripts intact.

## 8. Done checklist

- [ ] 5 deps removed; Docker client image builds without git
- [ ] `initSse` + scaffold e2e + `vercel.example.json` + `.pnpm-store` gone; comments fixed
- [ ] Shutdown hooks enabled; lint split; scripts portable
- [ ] Env examples labeled per Q6; compose healthcheck points at `/login`
- [ ] CI workflow green on its own PR, incl. migrate smoke
- [ ] `PROGRESS.md` updated (12 findings)
