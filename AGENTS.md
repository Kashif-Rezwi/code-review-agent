# AGENTS.md — Guide for AI Coding Agents

> Canonical instructions for working in this repository, following the open [agents.md](https://agents.md) convention. This is the **only** agent-guidance file in the repo — there are deliberately **no vendor-specific files** (no `CLAUDE.md`, no `.cursorrules`, no copilot instructions) so the workflow stays usable with any provider or harness. Keep this file accurate — it is the first thing an agent reads.

## What this project is

**Code Review Agent** — a full-stack SaaS that performs AI-driven code reviews on pasted code or public GitHub PR URLs. Reviews stream live over SSE, are persisted to Postgres, and support follow-up chat. Multi-agent clustered PR review: PRs are split into domain clusters reviewed by parallel worker agents, then synthesised into one report.

## Monorepo layout (pnpm workspaces)

| Path | Package | Stack |
|---|---|---|
| `apps/server` | `server` | NestJS 11, Prisma 6 + pgvector (Neon), BullMQ + Redis (ioredis), AI SDK `ai` (bundles the Vercel AI Gateway provider) + `@openrouter/ai-sdk-provider` — chat router selected via `AI_ROUTER`, embeddings pinned to the gateway |
| `apps/client` | `client` | Next.js 16 (App Router, Turbopack), React 19, NextAuth 4 (GitHub OAuth, JWT sessions), Tailwind 4 |
| `packages/ai` | `@cra/ai` | Prompts, clustering, embeddings (`chunkText`), linter tool factory, `PRFileSchema` |
| `packages/types` | `@cra/types` | Zod contracts shared by server + client (`ReviewDataSchema`, `ReviewStreamEvent`) |

## Commands (run from repo root)

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Dev (client + server) | `pnpm dev` |
| Build shared packages (required first) | `pnpm build:packages` |
| Full build | `pnpm build` |
| Type-check (all 4 projects) | `pnpm type-check` |
| Server unit tests | `pnpm --filter server test` (jest, 21 suites) |
| Client tests | `pnpm --filter client test` (vitest, 9 files) |
| Lint | `pnpm lint` — read-only (non-zero exit on findings). The mutating fixer is `pnpm --filter server lint:fix` |
| DB migrations | `cd apps/server && npx prisma migrate deploy` |

Server env: `apps/server/.env` (see `.env.example`); client env: `apps/client/.env`. Never commit `.env` files.

## Verification loop — run before declaring any change "done"

1. `pnpm build:packages`
2. `pnpm type-check`
3. Targeted tests: `pnpm --filter server test` and/or `pnpm --filter client test`
4. `pnpm lint` — must exit 0
5. If you touched streaming/queue/review behavior, re-check against `docs/review-pr.md` contracts and `packages/types/src/index.ts`.

Current baseline is **green** on all of the above — keep it that way.

## Conventions

- TypeScript everywhere. Match the style of the file you edit: server code uses 4-space indent, single quotes, no semicolons; client uses 2-space indent. Prettier config: `singleQuote: true`, `trailingComma: 'all'`.
- NestJS: feature modules with controller/service/repository split; DTOs use `class-validator`; global `ValidationPipe({ whitelist: true })` is registered in `main.ts`.
- Shared contracts live in `packages/types` (zod). If server and client need the same shape, define it there — do not duplicate.
- The AI SDK's generics are isolated in `apps/server/src/ai/ai-runtime.adapter.ts`. Domain code consumes only that minimal surface — extend the adapter rather than leaking SDK types.
- Server `nest build` uses the swc builder; `@swc/*` deps are load-bearing, do not remove.

## Doc trust map (as of 2026-08-12, post-remediation)

All 80 findings from `AUDIT-REPORT.md` are resolved or recorded (see `remediation/PROGRESS.md`), and every doc was re-verified against the code during remediation:

- **Trust:** all of `docs/` + `README.md` — rewritten/corrected in remediation chunks 03–06
- **Historical intent, not current truth:** `Clustered-PR-Review-Spec.md`, `AI-CodeReview-SaaS-Masterplan.md` (both carry a banner saying so)

Ground truth is always the code. `AUDIT-REPORT.md` is a point-in-time report, not a living reference.

## Safety rails

1. **Never edit an applied Prisma migration.** New changes = new migration files only. (The `20260301000000_baseline_core` baseline is applied in every environment, including live — do not touch it.)
2. Never commit `.env` / secrets. `.env.example` edits are fine.
3. Preserve working behavior. No drive-by refactors, no "cleanups" outside your task's scope (see M-10: `ReviewService` size is known debt, not a mandate).
4. Do not add dependencies without justification in the task/chunk.
5. BullMQ jobs are non-idempotent and expensive (LLM calls) — do not add auto-retries to the queue.

## Use any provider or harness

Everything here is plain Markdown + conventions — no vendor-specific features:

- **Harnesses that natively read `AGENTS.md`** (Codex, Cursor, Jules, Amp, Zed, Roo, …): works out of the box.
- **Harnesses with their own auto-discovered filename** (e.g. Claude Code, Copilot): create a *local, uncommitted* one-line pointer (e.g. a `CLAUDE.md` containing `@AGENTS.md`) or paste this file into the tool's custom instructions. Never duplicate content into a pointer — this file remains the single source of truth.
- **Chat-only usage** (any web LLM): paste `AGENTS.md` + the relevant chunk from `remediation/chunks/` — that pair is the whole contract.

## Remediation work (audit follow-up) — complete

All 10 chunks covering the 80 findings of `AUDIT-REPORT.md` are done (2026-08-12). What remains useful:

- `remediation/PROGRESS.md` — per-chunk record + "Discovered during remediation" table (where new findings land)
- `remediation/decisions/` — six ADRs for the deferred/decision findings (resilient DB boot, worker concurrency, TS linting, chat windowing, streamer polling, ReviewService size)
- `remediation/chunks/` + `remediation/README.md` — execution records and the loop protocol that was used
