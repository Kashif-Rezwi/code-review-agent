# Remediation Progress Board

Master status for the 80 findings in `AUDIT-REPORT.md`. Update this file at chunk start (→ `in-progress`) and completion (→ `done`, with date + notes). Protocol: `remediation/README.md`.

**Status legend:** `pending` · `in-progress` · `blocked` (say why) · `done`

| Chunk | Status | Findings | Closed | Date | Notes / deviations |
|---|---|---|---|---|---|
| 00 database-deploy-reproducibility | done | M-1, M-2, M-7, E-3, M-9 (5) | 5/5 | 2026-08-12 | Q1 = A (prepend baseline). Live Neon reconciled (`resolve --applied` baseline) + index migration deployed; `migrate status` clean. Bonus drift fix: index migration also drops undocumented `Document.userId` DEFAULT on live. Verified on empty `pgvector/pgvector:pg16` container (fresh `migrate deploy` ✅, `migrate diff` empty ✅). |
| 01 server-runtime-bugs | done | S-1, S-3, S-7, S-8 (4) | 4/4 | 2026-08-12 | +5 spec files (65 tests total). Folded in the minimal ESLint flat-config fix — the linter never ran at all (see Discovered). Model-facing lint wording unchanged. |
| 02 security-cost-posture | done | C-1, S-4, S-5, M-3, A-31, A-32 (6) | 6/6 | 2026-08-12 | Q2=no (scope dropped — existing tokens keep `repo` until re-auth), Q3=public (@nestjs/throttler: 10 reviews/h + 60 chat/h per userId; in-memory storage — single-instance only), Q5=no consumers (`?token=` deprecation warn-log; removal later). Prod CORS no longer trusts localhost. |
| 03 docs-streaming-architecture | pending | A-1…A-10, B-1…B-4, B-6, A-37 (16) | 0/16 | — | Shares README with 06 — run sequentially |
| 04 docs-packages-types-reviewcode | pending | A-11…A-16, A-35, A-36 (8) | 0/8 | — | — |
| 05 docs-datamodel-rag | pending | A-17…A-20 (4) | 0/4 | — | Owns data-model.md exclusively |
| 06 docs-frontend-history-deploy-misc | pending | A-21…A-30, A-33, A-34, A-38, B-5, C-4, C-5, C-6 (17) | 0/17 | — | Shares README with 03 — run sequentially |
| 07 client-reliability-ux | done | C-2, C-7 (2) | 2/2 | 2026-08-12 | Build-time guard in `next.config.ts` + runtime guard in `apiFetch`; chat bubbles now surface real server messages. Client 9 files / 14 tests, lint 0, build ✅ with env / clear failure without. |
| 08 hygiene-deadcode-deps-ci | pending | M-5, M-6, M-8, C-3, S-9, E-1, E-2, E-4…E-8 (12) | 0/12 | — | CI last; Q6 gates E-6 wording |
| 09 deferred-decision-records | pending | S-2, M-4, S-6, S-10, S-11, M-10 (6) | 0/6 | — | ADRs only; Q4, Q7 |
| **Total** | | **80** | **17/80** | | |

## Session log

Append one line per work session: `YYYY-MM-DD · chunk NN · what happened · verification result`

- 2026-08-12 · setup · remediation system created (AGENTS.md, pointers, 10 chunks) · no code changes
- 2026-08-12 · chunk 00 · prepended `20260301000000_baseline_core`, added `20260812054909_add_hot_path_indexes` (5 indexes + `Document.userId` DROP DEFAULT), render.yaml `DATABASE_URL`/`DIRECT_URL` + branch note, compose/README/deployment notes; live Neon reconciled + deployed · fresh-DB `migrate deploy` + empty `migrate diff` on pg16 container; build:packages, type-check, 50 server tests green
- 2026-08-12 · chunk 01 · `CreateSessionDto` (+ dead DTOs deleted), `LintResult` contract (`output` to model, counts to SSE labeler via code-keyed map), ESLint flat-config fix, `deleteDocument` 404 via `deleteMany`, honest port log · 17 suites / 65 tests, type-check, lint (no `--fix`) all green
- 2026-08-12 · chunk 07 · `NEXT_PUBLIC_API_URL` build-time guard (next.config.ts) + runtime guard (apiFetch); chat catch surfaces real server messages with generic fallback · client 9 files / 14 tests, lint exit 0, build passes with env / fails clearly without
- 2026-08-12 · chunk 02 · OAuth scope → `read:user user:email`; `?token=` deprecation warn-log + docs warning; token cache hard-bounded at 500 (expired sweep → oldest-inserted eviction, refresh-on-set); `@nestjs/throttler` on the 2 paid endpoints (10/h reviews, 60/h chat, userId-keyed via route-level guard after AuthGuard); prod CORS = frontendUrl only · 20 suites / 72 tests, type-check + both lints green. Note: `pnpm add` temporarily broke `eslint-plugin-import` resolution for client lint — fixed by root `pnpm install` relink

## Discovered during remediation

New issues found while executing chunks land here (do NOT fix mid-chunk). Triage into a chunk later.

| # | Found in | Description | Severity suggestion |
|---|---|---|---|
| D-1 | chunk 01 (S-3) | **Linter never ran at all:** `linter.verify()` received an eslintrc-style config (`parserOptions` top-level); ESLint 9's flat-config `Linter` throws on it for *every* call, so the catch fallback was the only output ever produced (the audit assumed linting worked and only the label lied). **Fixed minimally in chunk 01** (config moved to `languageOptions`; rules/wording untouched). Related: S-6 (TS-aware linting) still open for chunk 09. | 🟠 (was latent) |
