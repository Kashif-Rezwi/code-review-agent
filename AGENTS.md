# AGENTS.md — Guide for AI Coding Agents

> Canonical instructions for working in this repository, following the open [agents.md](https://agents.md) convention. This is the **only** agent-guidance file in the repo — there are deliberately **no vendor-specific files** (no `CLAUDE.md`, no `.cursorrules`, no copilot instructions) so the workflow stays usable with any provider or harness. Keep this file accurate — it is the first thing an agent reads.

## What this project is

**Code Review Agent** — a full-stack SaaS that performs AI-driven code reviews on pasted code or public GitHub PR URLs. Reviews stream live over SSE, are persisted to Postgres, and support follow-up chat. Multi-agent clustered PR review: PRs are split into domain clusters reviewed by parallel worker agents, then synthesised into one report.

## Monorepo layout (pnpm workspaces)

| Path | Package | Stack |
|---|---|---|
| `apps/server` | `server` | NestJS 11, Prisma 6 + pgvector (Neon), BullMQ + Redis (ioredis), AI SDK (`ai` + `@ai-sdk/openai`) |
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
| Server unit tests | `pnpm --filter server test` (jest, 12 suites) |
| Client tests | `pnpm --filter client test` (vitest, 8 files) |
| Lint | `pnpm lint` — ⚠️ server script runs `eslint --fix` (mutates files). For a read-only check use `cd apps/server && npx eslint "{src,apps,libs,test}/**/*.ts"` |
| DB migrations | `cd apps/server && npx prisma migrate deploy` |

Server env: `apps/server/.env` (see `.env.example`); client env: `apps/client/.env`. Never commit `.env` files.

## Verification loop — run before declaring any change "done"

1. `pnpm build:packages`
2. `pnpm type-check`
3. Targeted tests: `pnpm --filter server test` and/or `pnpm --filter client test`
4. Lint without `--fix` (command above) — must exit 0
5. If you touched streaming/queue/review behavior, re-check against `docs/review-pr.md` contracts and `packages/types/src/index.ts`.

Current baseline is **green** on all of the above — keep it that way.

## Conventions

- TypeScript everywhere. Match the style of the file you edit: server code uses 4-space indent, single quotes, no semicolons; client uses 2-space indent. Prettier config: `singleQuote: true`, `trailingComma: 'all'`.
- NestJS: feature modules with controller/service/repository split; DTOs use `class-validator`; global `ValidationPipe({ whitelist: true })` is registered in `main.ts`.
- Shared contracts live in `packages/types` (zod). If server and client need the same shape, define it there — do not duplicate.
- The AI SDK's generics are isolated in `apps/server/src/ai/ai-runtime.adapter.ts`. Domain code consumes only that minimal surface — extend the adapter rather than leaking SDK types.
- Server `nest build` uses the swc builder; `@swc/*` deps are load-bearing, do not remove.

## ⚠️ Doc trust map (as of 2026-08-12)

Some docs are stale after two major rewrites (Redis-Streams migration; dispatch-outbox + cancellation). Trust levels:

- **Trust:** `docs/review-pr.md` (excellent), `docs/github-integration.md`, `docs/history-chat.md`, `docs/review-code.md` (minor staleness)
- **Verify against code before relying on:** `docs/authentication.md`, `docs/frontend.md`, `docs/deployment.md`, `README.md`
- **Known-stale (being fixed via remediation chunks):** `docs/queue-streaming.md` (describes a deleted Redis List+Pub/Sub design — reality is Redis Streams), `docs/packages.md` (documents deleted GitHub tool factories), `docs/data-model.md` (missing `ReviewDispatch`), `docs/rag.md` (chunking described wrongly), `docs/architecture.md` (data-stores + tools stale)
- **Historical intent, not current truth:** `Clustered-PR-Review-Spec.md`, `AI-CodeReview-SaaS-Masterplan.md`

Ground truth is always the code + `AUDIT-REPORT.md`.

## Safety rails

1. **Never edit an applied Prisma migration.** New changes = new migration files only. (Baseline-migration work is chunk 00 — follow its instructions exactly.)
2. Never commit `.env` / secrets. `.env.example` edits are fine.
3. Preserve working behavior. No drive-by refactors, no "cleanups" outside your task's scope (see M-10: `ReviewService` size is known debt, not a mandate).
4. Do not add dependencies without justification in the task/chunk.
5. BullMQ jobs are non-idempotent and expensive (LLM calls) — do not add auto-retries to the queue.

## Use any provider or harness

Everything here is plain Markdown + conventions — no vendor-specific features:

- **Harnesses that natively read `AGENTS.md`** (Codex, Cursor, Jules, Amp, Zed, Roo, …): works out of the box.
- **Harnesses with their own auto-discovered filename** (e.g. Claude Code, Copilot): create a *local, uncommitted* one-line pointer (e.g. a `CLAUDE.md` containing `@AGENTS.md`) or paste this file into the tool's custom instructions. Never duplicate content into a pointer — this file remains the single source of truth.
- **Chat-only usage** (any web LLM): paste `AGENTS.md` + the relevant chunk from `remediation/chunks/` — that pair is the whole contract.

## Remediation work (audit follow-up)

This repo is executing the findings of `AUDIT-REPORT.md` (80 findings) via self-contained chunks in `remediation/`. If your task references a finding ID (A/S/C/E/M series) or a chunk:

1. Read `remediation/README.md` (loop protocol)
2. Read your chunk file in `remediation/chunks/` — it embeds findings, evidence, context briefs, tasks, and verification steps
3. Check `remediation/PROGRESS.md` for current status before starting
4. Update `PROGRESS.md` when your chunk is done
