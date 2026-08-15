# Razorpay Payment Integration — Context

> Feature-level context document for the Razorpay integration. This is the persistent source of truth for the planning and implementation stages of this feature. The authoritative audit record lives in [`01-audit.md`](./01-audit.md).

## What this feature is

**Add Razorpay-powered prepaid credits to Code Review Agent** — a currently-free SaaS that performs AI-driven code reviews for GitHub OAuth-authenticated users. Razorpay is the first (and for now only) monetization layer, implementing a **prepaid credit wallet** model:

- Every user gets a small pool of **free credits** on signup, enough for a limited number of reviews and chat messages.
- Users can **recharge** their credit wallet by paying through Razorpay (one-time purchases — no subscriptions, no recurring billing).
- Every AI operation (review, chat message) **consumes credits** based on the model and operation type. Credit cost per operation is configurable server-side.
- **No expiry, no renewal, no cancellation, no refunds.** Credits are prepaid and persist until consumed.

The integration covers: Razorpay Checkout on the client for credit top-ups, order creation + webhook handling on the server for idempotent credit crediting, a credit-wallet model (balance + ledger), and a credit-balance gate on the existing review and chat pipelines.

## Why this stage exists

The planning stage has a single mandate: **understand the existing codebase and document every conclusion, constraint, and recommendation before any source code changes.** This document (and `01-audit.md`) captures that understanding. Implementation will reference these files rather than re-deriving decisions from chat history.

## Scope of this document

- What the feature is trying to achieve and why.
- Which existing project documents were consulted (the "source of truth" for conventions).
- What decisions have already been made versus what is still open.
- Where Razorpay fits in the existing architecture.
- How this feature interacts with the existing repo documentation.

---

## Source documents consulted

These documents define the conventions this feature must follow. They were read in full during the audit and are treated as the authoritative contract — not reinterpreted.

| Document | Role for this feature |
|---|---|
| `AGENTS.md` | Monorepo layout, commands, verification loop, safety rails, doc-trust map |
| `docs/architecture.md` | Queue-backed, event-streaming architecture; component map |
| `docs/authentication.md` | GitHub OAuth as the sole credential; `AuthGuard` / `TokenCacheService` |
| `docs/data-model.md` | Prisma models, migration rules, GitHub user ID as PK |
| `docs/frontend.md` | App Router structure, `apiFetch` + service objects, `proxy.ts` matcher |
| `docs/deployment.md` | Render + Vercel, env-var reference, reserved `STRIPE_*` entries |
| `docs/queue-streaming.md` | BullMQ, dispatch outbox, Redis Streams — and the "no auto-retry" rule |
| `docs/review-code.md` / `docs/review-pr.md` | The review endpoints Razorpay will ultimately monetize |
| `docs/history-chat.md` / `docs/rag.md` | Existing usage-counting and RAG patterns — templates for entitlement/usage |
| `docs/packages.md` | `@cra/ai` and `@cra/types` conventions for shared contracts |
| `AI-CodeReview-SaaS-Masterplan.md` | **Historical intent only** (per AGENTS.md trust map) — source of the monetization intent; the implemented model diverges (prepaid credits, D-4) |
| `AUDIT-REPORT.md` | Point-in-time audit (A-24, E-6 flag reserved Stripe keys) — the Razorpay work must retire these cleanly |
| `remediation/decisions/001-006.md` | ADR style for any deferred decisions this feature records |
| `apps/server/prisma/schema.prisma` | The schema being extended (additive migration only — safety rail #1) |

---

## Existing conventions this feature inherits

These are not up for debate — they come from `AGENTS.md` and the existing codebase:

1. **Monorepo layout**: `apps/server` (NestJS 11), `apps/client` (Next.js 16), `@cra/ai`, `@cra/types`. Razorpay fits as a new `apps/server/src/payments/` module + (optionally) a shared contract in `@cra/types` if the client renders credit-wallet state from a Zod-validated shape.
2. **TypeScript everywhere**, 4-space indent on the server, 2-space on the client; `singleQuote`, `trailingComma: 'all'`.
3. **Verification loop**: `pnpm build:packages` → `pnpm type-check` → targeted tests → `pnpm lint` (must exit 0) — required before declaring any implementation chunk done.
4. **Additive migrations only**: never edit an applied migration; `20260301000000_baseline_core` is applied in live and must never be touched.
5. **No auto-retries on BullMQ** (safety rail #5): expensive LLM jobs are not idempotent. Webhook processing must therefore be **synchronous in-request**, never a BullMQ job.
6. **No new dependencies without justification** (safety rail #4): the `razorpay` SDK vs. plain `fetch` decision must be recorded with reasoning.
7. **No drive-by refactors** (safety rail #3): the reserved `STRIPE_*` env vars are the only existing payment-adjacent surface, and removing them cleanly is in-scope (audit finding A-24/E-6).
8. **Doc-trust map**: ground truth is the code; historical intent docs (`AI-CodeReview-SaaS-Masterplan.md`, `Clustered-PR-Review-Spec.md`) are not current truth.

---

## How Razorpay fits in the existing architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                         Browser (Next.js)                         │
│  GitHub OAuth → Review Page ──┬── Account Page (NEW)              │
│                               │    └── "Recharge credits" CTA     │
│                               └── Razorpay Checkout popup (NEW)   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ HTTPS
┌───────────────────────────────▼───────────────────────────────────┐
│                         NestJS API Server                         │
│                                                                   │
│  POST /review/session ──► [NEW: credit-balance gate] ──► existing │
│  POST /history/:id/chat ► [NEW: credit-balance gate]     pipeline │
│                                                                   │
│  POST /payments/order ──► PaymentsService ──► Razorpay Orders API │
│  POST /payments/webhook ──► HMAC verify ──► idempotent credit add │
│                                                                   │
│  GET  /payments/wallet ──► DB read (credit balance + ledger)      │
└───────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                     Razorpay API + Webhooks (external)
```

The new `PaymentsModule` is a sibling to `ReviewModule`/`HistoryModule`/`RagModule`. It shares `AuthGuard` (for user-initiated endpoints), `PrismaService` (for orders / events / credit-wallet rows), and `ConfigService` (for `RAZORPAY_*` env vars). The webhook endpoint is **not** protected by `AuthGuard` — matching the existing `HealthController` precedent for unauthenticated routes. There is no separate `/payments/verify` endpoint — Razorpay webhooks are the authoritative credit-source path; the client polls `/payments/wallet` after checkout to see the updated balance.

---

## Decisions already made

| # | Decision | Source |
|---|---|---|
| D-1 | Razorpay is the payment provider (replaces the masterplan's Stripe choice). | Feature brief |
| D-2 | Documentation lives in `docs/features/razorpay/`. | This document |
| D-3 | `docs/features/razorpay/01-audit.md` is the authoritative audit record for this stage. | Audit stage |
| D-4 | **Prepaid credit wallet** model — one-time purchases, no subscriptions, no recurring billing. | Product decision |
| D-5 | Credits do **not** expire and are **not** refundable. No cancellation UI. | Product decision |
| D-6 | Free credits granted on signup, enough for a limited number of reviews + chat messages. | Product decision |
| D-7 | Credit cost per operation is configurable server-side (varies by AI model/operation). | Product decision |
| D-8 | Support all Razorpay payment methods that are straightforward per Razorpay's docs (cards, UPI, international cards). | Product decision |
| D-9 | **No** separate client-side verify endpoint. Razorpay webhooks are the authoritative credit source; the client polls `/payments/wallet` after checkout. | Architecture decision |
| D-10 | **No** public pricing/landing page. Users recharge credits from their in-app Account page. | Product decision |
| D-11 | Multiple concurrent orders per user are allowed but must be handled carefully (server-side safeguards). | Product decision |
| D-12 | Use the **official `razorpay` npm SDK** for server-side Razorpay integration. | Technical decision |
| D-13 | Branch strategy: `payment-integration` → merge to `develop` → merge to `main`. | Workflow decision |
| D-14 | Webhook event set and GST/tax invoicing are **deferred** — to be brainstormed in the implementation plan. | Product decision |

## Decisions still open (deferred)

Only two questions remain open for the implementation stage. They do not block the start of implementation but must be resolved before go-live:

1. **Webhook event subset**: which Razorpay events to listen for (`payment.captured`, `payment.failed`, `order.paid`, etc.). Requires a brainstorm in `02-implementation-plan.md`.
2. **GST / tax invoicing**: whether to use Razorpay's Invoices API for compliant GST invoices or leave invoicing out of scope for v1. Requires a brainstorm in `02-implementation-plan.md`.

---

## What this feature does NOT do in this stage

- **No source-code changes.** The planning stage is read-only.
- **No Razorpay dashboard setup.** That belongs to the implementation stage (API keys, webhook URL registration, test-mode vs. live-mode rollout).
- **No client-side Razorpay Checkout.js integration.** Documented but not installed.
- **No Prisma migration.** Schema changes are described in `01-audit.md` §7 but the migration itself is part of the implementation chunk.

---

## What this feature expects next

The two deferred questions (webhook events, GST invoicing) will be brainstormed during the implementation-planning stage and recorded in:

```
docs/features/razorpay/02-implementation-plan.md
```

That plan breaks the work into small verifiable chunks following the existing verification loop, each referencing the audit findings and conventions documented here. It will also define the exact credit-cost table per AI model/operation (code review, PR review, chat message, etc.).
