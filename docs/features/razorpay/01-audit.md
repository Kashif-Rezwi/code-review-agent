# Razorpay Payment Integration — Repository Audit

> **Stage:** Planning (read-only)
> **Branch:** `payment-integration` (HEAD `9f32e77`) → merges to `develop` → merges to `main`.
> **Baseline reference:** `main` (HEAD `822fa43`) — merge-base is `9f32e77`, so `payment-integration` is strictly behind `main` at time of audit.
> **Scope:** Audit the existing codebase for Razorpay integration readiness. No source-code modifications.
> **Related:** [`00-context.md`](./00-context.md) (feature context, resolved decisions, deferred questions).

This document is the authoritative record of what exists today, what Razorpay will need, and which risks the implementation must address. Implementation chunks must reference findings in this file by section/number rather than re-deriving them.

---

## 1. Executive summary

- **No payment functionality exists today.** Exhaustive grep across `apps/` and `packages/` returned zero matches for `razorpay`, `stripe`, `paddle`, `lemonsqueezy`, `subscription`, `invoice`, `webhook`, `checkout`, `billing`, or `payment` in any source file. The only payment-adjacent artifacts are:
  - Reserved `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID` in `apps/server/.env.example` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in `apps/client/.env.example` — explicitly labeled *"Not implemented (reserved)"* in both files and in `docs/deployment.md` §Environment Variable Reference.
  - `STRIPE_*` flagged in `AUDIT-REPORT.md` findings A-24 ("`STRIPE_*` keys are likewise inert") and E-6 ("`.env.example`s advertise inert keys … with no 'not implemented' marker" — the marker was added during remediation).
  - Historical Stripe-based Free/Pro model described in `AI-CodeReview-SaaS-Masterplan.md` (per the AGENTS.md trust map, this is **historical intent, not current truth**).
- **Razorpay replaces the masterplan's Stripe choice and pivots from subscription to prepaid credits.** The masterplan described a Free/Pro subscription; the implemented model is a **prepaid credit wallet**: free credits on signup, Razorpay-purchased top-ups, credits consumed per AI operation (code review / PR review / chat message) with configurable per-model cost — PR reviews price higher because one review fans out to N cluster workers + synthesis. It fits the existing architecture as one new NestJS feature module (`apps/server/src/payments/`) + one additive Prisma migration (orders, events, credit-wallet rows) + one new client Account page + touchpoints on the review and chat pipelines for the credit-balance gate.
- **Two hard technical constraints discovered:**
  1. The server has **no raw-body capture** (`apps/server/src/main.ts` uses default `NestFactory.create`); Razorpay webhook HMAC-SHA256 signature verification requires the raw request body. Fix: `{ rawBody: true }` in `NestFactory.create` (supported in Nest 11; adds `req.rawBody` without disturbing existing routes).
  2. The webhook route must bypass `AuthGuard` (existing pattern: `HealthController` is the sole unauthenticated controller today) and must not be parsed by the global `ValidationPipe({ whitelist: true })` — webhook payloads are Razorpay's shape, not ours.
- **Branch strategy (decided):** `payment-integration` → merge to `develop` → merge to `main`. The branch needs to be brought current with `main` (or `develop`, whichever is ahead) before implementation begins.
- **No auto-retry on BullMQ** (safety rail #5) means webhook processing must be synchronous in-request, not a queued job.
- **Credit source of truth:** Razorpay webhooks only — there is no client-side verify endpoint (decided in D-9). The client polls `GET /payments/wallet` after checkout to observe the balance update.

---

## 2. Relevant architecture

### Server (`apps/server`, NestJS 11 + Express 5)

- **Feature-module layout**: each domain (`auth`, `github`, `history`, `linter`, `prisma`, `queue`, `rag`, `review`, `throttle`, `users`) is a NestJS module with controller / service / repository split. `PaymentsModule` will follow this exact shape.
- **Module registration**: `apps/server/src/app.module.ts` imports every feature module and registers `ConfigModule.forRoot({ isGlobal: true })` and `ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }] })`.
- **Auth**: `AuthGuard` applied **per-controller** via `@UseGuards(AuthGuard)`. `HealthController` is the sole precedent for an unauthenticated route — the Razorpay webhook endpoint uses the same pattern (no guard decorator).
- **Rate limiting**: `UserThrottlerGuard` (`apps/server/src/throttle/user-throttler.guard.ts`) keys throttles on `req.user.userId` instead of IP. Must run after `AuthGuard`. Applied via `@UseGuards(UserThrottlerGuard)` + `@Throttle(...)` on specific endpoints (e.g. `POST /review/session` is 10/hr; chat is 60/hr). Pattern fits an order-creation endpoint cleanly.
- **Global validation**: `apps/server/src/main.ts` registers `ValidationPipe({ whitelist: true })` globally — strips unknown DTO fields. Webhook handler must opt out (raw body, not a DTO).
- **Config**: services inject `ConfigService` from `@nestjs/config` and read `config.get('VAR_NAME')`. `process.env` access is allowed only at bootstrap (the `FRONTEND_URL` read in `main.ts` is the exception).
- **CORS**: restricted to `FRONTEND_URL` (production) or `[FRONTEND_URL, 'http://localhost:3000']` (dev). Razorpay Checkout runs **in the browser**, so CORS doesn't affect it; webhook calls come server-to-server from Razorpay and bypass CORS.
- **Health**: `HealthController` is the precedent for unauthenticated routes, and the template for any optional extension to report Razorpay config presence.

### Client (`apps/client`, Next.js 16 App Router)

- **Auth gating**: `apps/client/proxy.ts` is the Next.js 16 proxy (successor to middleware); it reads the NextAuth JWT via `getToken` and redirects unauthenticated users to `/login`. Current matcher: `['/review/:path*', '/history/:path*', '/standards/:path*']` — the Account page needs `/account` added to the matcher.
- **API layer**: `apps/client/lib/api.ts` exports a typed `apiFetch<T>` wrapper plus per-domain service objects (`historyService`, `reviewService`, `ragService`). A `paymentsService` belongs here, following the same shape.
- **Page template**: `apps/client/app/standards/page.tsx` + `apps/client/lib/use-standards-documents.ts` is the exact template for the new Account page — client component + `useSession` + a custom data hook.
- **Nav**: `apps/client/components/layout/app-header.tsx` has a `NAV` constant (`Review`, `Standards`, `History`). A credit-balance indicator and Account entry go here.
- **Shared types**: `apps/client/types/next-auth.d.ts` augments NextAuth session with `githubToken: string` — Razorpay-related client state doesn't need a similar augmentation (credit balance comes from an API call, not the session).

### Database (Prisma 6 + Postgres/Neon + pgvector)

- **Schema**: `apps/server/prisma/schema.prisma` — 7 models today (`User`, `Review`, `ReviewDispatch`, `Issue`, `Conversation`, `Document`, `DocumentChunk`). Lean by design; payments will add 2–3 more.
- **Migrations**: 6 applied migrations; the `20260301000000_baseline_core` is applied in the live Neon DB and must **never** be edited (safety rail #1). All new models go into a new migration file.
- **User identity**: `User.id` is the GitHub numeric user ID stored as a string (e.g. `"12345678"`), not a UUID. Razorpay customer/payment notes must map to this string PK; `User.email` can be `null` (private GitHub email), so Razorpay receipt metadata must tolerate that.

### Queue/streaming (BullMQ + Redis Streams + Postgres dispatch outbox)

- **Review pipeline**: `POST /review/session` atomically writes a `Review` row + `ReviewDispatch` outbox row in `$transaction`, then the 2-second dispatcher polls and enqueues BullMQ. Webhook processing should **not** enter this pipeline — Razorpay events are idempotent state updates, not expensive LLM jobs.
- **State-transition pattern**: `ReviewDispatcherService` and `ReviewRepository` use `updateMany` with status-guard `where` clauses for atomic, idempotent state transitions. **This is the exact pattern webhook handlers should copy** (e.g. "mark order captured only if not already captured").
- **No auto-retries** (safety rail #5): webhook handlers must be idempotent and ack on any 2xx, even if some downstream effect fails (the webhook is retried on non-2xx).

### Deployment

- **Render (API + Redis)**: `render.yaml` — deploys **only from `main`**; free-tier cold starts may delay first webhook processing (Razorpay retries, harmless).
- **Vercel (client)**: auto-deploys on `main` push.
- **Local dev**: `docker-compose.yml` runs Redis + API only (no Postgres — external Neon); no public URL means webhook testing needs a tunnel (ngrok, localtunnel) — Razorpay has no Stripe-CLI equivalent.


---

## 3. Existing payment / billing-related functionality

### Implemented: none

Zero payment code. Zero billing models. Zero subscription/entitlement logic. Confirmed by grep:

| Term | Matches in source code |
|---|---|
| `razorpay`, `stripe`, `paddle`, `lemonsqueezy` | 0 |
| `payment`, `billing`, `invoice`, `webhook` (source) | 0 |
| `subscription` (source) | 0 |

### Closest analogs (building blocks for the feature)

| Capability | Where | Relevance |
|---|---|---|
| Per-user rate limiting | `apps/server/src/throttle/user-throttler.guard.ts` + `@Throttle` decorators | Complements (not replaces) credit-balance gate — rate limit still protects against abuse even with credits |
| Per-user usage counting | `apps/server/src/history/history.repository.ts` `getStats()` | Template for ledger queries (credits consumed by operation type) |
| Product intent | `AI-CodeReview-SaaS-Masterplan.md` (historical) §Week 7 + §Prisma Schema | Source of the original monetization intent; Razorpay + prepaid credits diverge from the masterplan's Stripe Free/Pro subscription model |
| Reserved env vars | `apps/server/.env.example`, `apps/client/.env.example` | Inert. Audit findings A-24/E-6 flagged them as misleading; Razorpay work should retire the `STRIPE_*` keys cleanly |

---

## 4. Relevant files and why they matter

### Server — must change

| File | Change | Why |
|---|---|---|
| `apps/server/src/app.module.ts` | Register new `PaymentsModule` | Feature-module registration point |
| `apps/server/src/main.ts` | `NestFactory.create(AppModule, { rawBody: true })` | Webhook HMAC-SHA256 needs `req.rawBody`; existing bootstrap has no raw-body capture |
| `apps/server/prisma/schema.prisma` | Add `PaymentOrder`, `PaymentEvent` (idempotency), `CreditLedger`, `User.creditBalance` | New migration required (safety rail #1) |
| `apps/server/src/auth/auth.guard.ts` | No change (pattern reference) | Guard application pattern; payment endpoints use it, webhook endpoint must not |
| `apps/server/src/users/users.service.ts` | Add single-shot free-credit grant on first user creation | Prepaid onboarding hook — see §7 item 6 |
| `apps/server/src/queue/redis.service.ts` | No change (pattern reference) | `ConfigService` constructor-injection template |
| `apps/server/src/review/dto/create-session.dto.ts` | No change (pattern reference) | Class-validator DTO style to follow for payment DTOs |
| `apps/server/src/review/review.controller.ts` `POST /review/session` | Add credit-balance gate **before** `reviewService.createSession` | Gate that checks `creditBalance >= creditCostForOperation(type)` and deducts on success |
| `apps/server/src/history/history.controller.ts` `POST /:id/chat` | Add credit-balance gate **before** streaming chat | Same gate for chat messages |
| `apps/server/src/health.controller.ts` | Optional: report `razorpay` config presence | Pattern for unauthenticated controller + health reporting |
| `apps/server/.env.example` | Add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`; **retire** `STRIPE_*` | Resolves audit findings A-24/E-6 |

### Server — new files (module skeleton)

| Path | Role |
|---|---|
| `apps/server/src/payments/payments.module.ts` | NestJS module wiring |
| `apps/server/src/payments/payments.controller.ts` | `POST /payments/order`, `POST /payments/webhook`, `GET /payments/wallet` |
| `apps/server/src/payments/payments.service.ts` | Razorpay SDK wrapper (order creation, webhook signature verification, credit crediting) |
| `apps/server/src/payments/payments.repository.ts` | Order / event / credit-wallet persistence + idempotency |
| `apps/server/src/payments/credit-cost.policy.ts` | Per-operation, per-model credit-cost table (server-configurable) |
| `apps/server/src/payments/credit.guard.ts` | NestJS guard that checks credit balance before review/chat; deducts on success |
| `apps/server/src/payments/dto/create-order.dto.ts` | Input validation for order creation |
| `apps/server/src/payments/*.spec.ts` | Tests (idempotency, signature verification, credit gate, credit-cost policy) |

### Client — must change

| File | Change | Why |
|---|---|---|
| `apps/client/lib/api.ts` | Add `paymentsService` object (`createOrder`, `getWallet`) | Follow existing service-object pattern |
| `apps/client/proxy.ts` | Add `/account` to `config.matcher` | Auth gate for account page |
| `apps/client/components/layout/app-header.tsx` | Credit balance indicator + Account nav entry | User-facing credit state |
| `apps/client/.env.example` | Add `NEXT_PUBLIC_RAZORPAY_KEY_ID`; **retire** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Resolves audit finding E-6 |

### Client — new files

| Path | Role |
|---|---|
| `apps/client/app/account/page.tsx` | Account page with credit balance, transaction ledger, "Recharge credits" CTA — modeled on `app/standards/page.tsx` |
| `apps/client/lib/use-wallet.ts` | Custom hook fetching credit balance + ledger from `GET /payments/wallet` |
| Razorpay Checkout.js popup flow | Inline in account page using Razorpay's script tag (no npm dependency — just the official Checkout.js) |

### Deployment / docs — must change

| File | Change |
|---|---|
| `render.yaml` | Add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (all `sync: false`) |
| `docs/deployment.md` | Update env-var reference tables; remove `STRIPE_*` entries |
| `docs/data-model.md` | Add new payment/credit-wallet models after migration |
| `docs/architecture.md` | Component map and "External dependencies" section — add Razorpay |
| `docs/features/razorpay/02-implementation-plan.md` | The implementation plan (next artifact) |
| `docker-compose.yml` | Document webhook-tunnel requirement (ngrok/localtunnel) — no code change |

---

## 5. Existing conventions to follow

These are non-negotiable — they come from `AGENTS.md`, the remediation decisions, and consistent practice across the codebase.

- **TypeScript everywhere**. Server: 4-space indent, single quotes, no semicolons. Client: 2-space indent.
- **Prettier**: `singleQuote: true`, `trailingComma: 'all'`.
- **NestJS patterns**: feature modules, controller/service/repository split, DTOs with `class-validator`, `Logger` per class, `HttpException` subclasses for error responses, ownership checks throw `NotFoundException` (see `HistoryService.getReview`), `ConfigService` injection for env vars.
- **DB writes**: `$transaction` for atomic multi-row writes (`ReviewRepository`, `RagRepository`); `updateMany` with status-guard `where` for atomic transitions (`ReviewDispatcherService`, `ReviewRepository.markCancelled`). Webhook handlers copy this pattern for idempotent state transitions.
- **Testing**: Jest in `apps/server` (colocated `*.spec.ts`, currently 21 suites); Vitest in `apps/client` (9 files). New module must ship with specs covering: signature verification, webhook idempotency + ordering, credit-gate enforcement, client-side flow.
- **Verification loop** (required before any chunk is "done"):
  1. `pnpm build:packages`
  2. `pnpm type-check`
  3. `pnpm --filter server test` and/or `pnpm --filter client test`
  4. `pnpm lint` — must exit 0
- **No new dependencies without justification** (safety rail #4): the official `razorpay` npm SDK has been chosen (decision D-12) — record the justification as an ADR when the dependency is added.
- **Shared contracts**: if the server emits credit-wallet state to the client in a shape both sides must agree on at compile time (balance, ledger entries), define the Zod schema in `@cra/types` (per `ReviewStreamEvent` / `ReviewDataSchema` precedent).

---

## 6. Risks and security concerns

### 6.1 Webhook trust boundary

Webhook requests arrive from the public internet, unauthenticated. Before any processing:

- Read `req.rawBody` (requires `{ rawBody: true }` in `NestFactory.create`).
- Verify `X-Razorpay-Signature === HMAC-SHA256(req.rawBody, RAZORPAY_WEBHOOK_SECRET)` using `crypto.timingSafeEqual` for the comparison.
- Reject (401) any request whose signature doesn't match — before DB reads.
- The webhook route must **not** be guarded by `AuthGuard` and must **not** be parsed by the global `ValidationPipe({ whitelist: true })`.

### 6.2 Duplicate payments

- Multiple concurrent orders per user are **allowed** (decision D-11) — double-clicks and network retries are expected. Each order is credited independently and exactly once: `PaymentOrder.razorpayOrderId` is unique, and crediting uses an atomic status-guard transition (`updateMany` where the order is still `PENDING`) so a paid order can never double-credit.
- Safeguards against abuse: order creation is rate-limited (§6.6); an optional soft cap on concurrent `PENDING` orders per user is a design decision for the implementation plan (D-11's "handled carefully").
- Dedupe webhook processing by Razorpay `payload.<entity>.entity.id` — `PaymentEvent` model has a unique index on the Razorpay event ID.

### 6.3 Webhook retries and ordering

- Razorpay retries non-2xx deliveries with exponential backoff; handlers must be idempotent and fast-ack (return 2xx as soon as the DB write succeeds, not after all side effects).
- Events can arrive out of order (e.g. `payment.captured` before `order.paid`). Handlers must be state-transition safe: use atomic `updateMany` with a `where` clause that guards the transition direction (see `ReviewDispatcherService` for the pattern).

### 6.4 State consistency

Razorpay is the payment source of truth; the local DB credit-wallet is the entitlement source of truth. "Paid but credits not added" is the main inconsistency window. Mitigations, in priority order:

1. Verified webhook applies credits atomically (primary path — single `$transaction` that inserts the `PaymentEvent` idempotency row and credits the wallet, using `updateMany` with a status-guard `where` to prevent double-crediting).
2. Client polls `GET /payments/wallet` after checkout to observe the balance update. There is **no** separate `/payments/verify` endpoint (decision D-9).
3. Background reconciliation query (optional v1; can be a manual `pnpm` script) that scans pending orders older than N minutes against Razorpay's Orders API.

### 6.5 Secrets

- `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` live server-side only.
- Only `RAZORPAY_KEY_ID` (the publishable identifier) goes to the client as `NEXT_PUBLIC_RAZORPAY_KEY_ID`.
- Never commit `.env` files (existing convention). Update `.env.example` + `docs/deployment.md` in the same chunk that adds the code.

### 6.6 Auth on payment endpoints

- `POST /payments/order` must derive `userId` from `req.user` (set by `AuthGuard`); never trust a client-supplied `userId`.
- Rate-limit order creation with `UserThrottlerGuard` to prevent abuse (matches the existing `POST /review/session` pattern).

### 6.7 Identity edge cases

- `User.email` can be `null` (private GitHub email, allowed by `apps/server/prisma/schema.prisma`). Razorpay customer/payment note fields must tolerate this — don't make email a Razorpay-customer identifier.
- `User.id` is a string (GitHub numeric ID cast); don't try to store it as Razorpay's customer ID without mapping.

### 6.8 Render cold starts

The API runs on Render's free tier and sleeps after inactivity. A webhook arriving during cold-start may time out on first attempt — Razorpay retries, so this is harmless, but worth documenting in `docs/deployment.md`.

### 6.9 Money types

- Razorpay amounts are integer **paise** (100 paise = ₹1). Store as Prisma `Int` (not `Float`, not `Decimal`) to avoid rounding.
- Charge currency is INR; international cards are accepted but still charged in INR (decision D-8). The `PaymentOrder.currency` column records the actual charge currency regardless.
- Credits are an internal unit — the paise→credits conversion rate is set by the credit-cost policy (§7 item 5), never derived client-side.

### 6.10 Raw-body bootstrap side effects

Adding `{ rawBody: true }` to `NestFactory.create` adds `req.rawBody` on every request but does not change how existing routes parse `req.body`. Should still be covered by a smoke test of the existing review/chat endpoints after the change.

### 6.11 Concurrent credit deduction (double-spend race)

The critical prepaid-wallet race: a user with 10 credits fires two review requests concurrently; both read `creditBalance = 10`, both pass a naive check, both deduct — the wallet goes negative (double-spend). A read-then-write guard is insufficient.

The deduction must be an **atomic conditional decrement** in a single `$transaction`:

1. `updateMany({ where: { id: userId, creditBalance: { gte: cost } }, data: { creditBalance: { decrement: cost } } })` — Postgres evaluates the `WHERE` against the row being updated, so at most one concurrent request wins when the balance can only cover one.
2. If `count === 0`, reject with `402 Payment Required` (insufficient credits) — no review job is created.
3. Append the `CONSUMPTION` `CreditLedger` entry (with `balanceAfter`) in the same transaction.

If the review later fails, credits are returned via a compensating `CONSUMPTION_REFUND` ledger entry + increment (§7 item 4). This mirrors the atomic status-guard transitions already used by `ReviewDispatcherService`/`ReviewRepository` (§5).

---

## 7. Missing capabilities required for Razorpay

These are the gaps between "what exists today" and "what Razorpay needs." Each item references the relevant risk (§6), convention (§5), or decision (`00-context.md`).

### Server-side

1. **Raw-body capture** in `apps/server/src/main.ts` (§6.1, §6.10).
2. **`PaymentsModule`** with controller/service/repository (§5 NestJS pattern):
   - `POST /payments/order` — creates a Razorpay Order via the SDK, returns `order_id` + `amount` (paise) + `currency` + `key_id` to the client. Authenticated; `userId` from `req.user`.
   - `POST /payments/webhook` — unauthenticated; verifies `X-Razorpay-Signature`, applies events idempotently (credits the wallet, records the event).
   - `GET /payments/wallet` — authenticated; returns current credit balance + recent ledger entries.
3. **Prisma migration** (safety rail #1 — additive only):
   - `PaymentOrder` — `id`, `userId`, `razorpayOrderId` (unique), `razorpayPaymentId?`, `amountPaise`, `currency`, `creditsGranted`, `status`, `createdAt`, `updatedAt`.
   - `PaymentEvent` — `id`, `razorpayEventId` (unique, idempotency), `razorpayOrderId`, `eventType`, `payload` (Json), `processedAt`, `createdAt`.
   - `CreditLedger` — `id`, `userId`, `type` (enum: `FREE_GRANT`, `PURCHASE`, `CONSUMPTION`, `CONSUMPTION_REFUND`), `amount`, `balanceAfter`, `orderId?`, `reviewId?`, `createdAt`. Append-only ledger for auditability; `CONSUMPTION_REFUND` covers the failed-review refund path (item 4).
   - `User` additions — `creditBalance Int @default(0)` (current balance; updated atomically on every ledger entry).
4. **Credit-balance gate** (`CreditGuard`): applied to `POST /review/session` and `POST /history/:id/chat`. Atomically deducts the operation's credit cost at admission (see §6.11 — conditional decrement, not read-then-write) and appends a `CONSUMPTION` ledger entry in the same transaction; insufficient balance → `402` before any job is created. If a review fails partway, credits are returned as a `CONSUMPTION_REFUND` entry — refund policy for partial/failed reviews is a design decision for the implementation plan.
5. **Credit-cost policy** (`credit-cost.policy.ts`): server-configurable table mapping operation type + AI model to credit cost. Should be easily editable without code changes (env-driven or DB-driven).
6. **Free-credit grant on signup**: hook into `UsersService.findOrCreate` to grant initial free credits to first-time users. Note: `prisma.user.upsert` does not report whether it created or updated, so the grant must be made single-shot another way — e.g. create-then-catch-duplicate, or a unique partial index on `CreditLedger(userId)` where `type = FREE_GRANT` so the grant insert itself is the idempotency guard.
7. **Env vars**: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. Retire `STRIPE_*` keys (resolves audit findings A-24, E-6).
8. **`razorpay` npm SDK dependency** (decision D-12): add to `apps/server/package.json`.
9. **Tests**: signature verification unit tests, webhook idempotency + ordering integration tests, credit gate tests (insufficient balance → 402; sufficient → deducts atomically), free-grant-on-signup tests.

### Client-side

1. **Account page**: `apps/client/app/account/page.tsx`. Modeled on `app/standards/page.tsx` — client component, `useSession`, custom `useWallet` hook. Shows credit balance, transaction ledger, and "Recharge credits" CTA.
2. **Razorpay Checkout.js integration**: load Razorpay's Checkout.js script tag at runtime (no npm dependency), invoke the checkout popup on CTA click, capture `razorpay_payment_id` + `razorpay_order_id` + `razorpay_signature` on success. No client-side verify call — poll `GET /payments/wallet` to observe the balance update.
3. **`api.ts` extension**: `paymentsService` object (`createOrder`, `getWallet`).
4. **`proxy.ts` matcher update**: add `/account`.
5. **Nav**: credit balance indicator + "Account" entry in `app-header.tsx`.
6. **Client env var**: `NEXT_PUBLIC_RAZORPAY_KEY_ID`. Retire `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

### Deployment / docs

1. `render.yaml`: add `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (all `sync: false`).
2. `docs/deployment.md`: update server + client env-var tables; remove `STRIPE_*` entries.
3. `docs/data-model.md`: document new payment/credit-wallet models.
4. `docs/architecture.md`: update component map + external-dependencies section.
5. `docker-compose.yml`: add a note in the top-of-file comment about needing a tunnel for webhook testing (no code change).

---

## 8. Constraints and assumptions

### Constraints (non-negotiable)

- Monorepo conventions + green verification loop preserved (safety rails from `AGENTS.md`).
- Additive Prisma migrations only — `20260301000000_baseline_core` is untouchable.
- No auto-retries added to BullMQ (unaffected; webhook path is synchronous).
- No drive-by refactors — the reserved `STRIPE_*` cleanup is in-scope because the audit findings name it explicitly.
- Razorpay webhooks must be synchronous in-request (BullMQ is for expensive, non-idempotent LLM jobs — the inverse profile).
- Credits do not expire and are not refundable (decisions D-5, D-6). No cancellation UI.
- Branch flow: `payment-integration` → `develop` → `main` (decision D-13).

### Assumptions (verify during planning → implementation)

- Razorpay is the chosen provider (supersedes masterplan's Stripe); business rationale recorded outside the repo.
- Prepaid credit wallet model (decision D-4) — not the masterplan's Free/Pro subscription.
- Free credits on signup are sufficient for a "couple of reviews and chat messages" (decision D-6). Exact amounts to be defined in the implementation plan.
- Credit cost per operation is configurable server-side and varies by AI model (decision D-7). The exact credit-cost table is defined in the implementation plan.
- All Razorpay payment methods that are straightforward per Razorpay's official docs will be supported: cards, UPI, international cards (decision D-8).
- `payment-integration` branch is strictly behind `main` at time of audit; needs to be brought current before implementation.
- Razorpay account is already provisioned or will be provisioned during the implementation stage; test-mode keys available for dev.
- The Razorpay dashboard webhook URL will be the production Render URL (set before go-live).
- The official `razorpay` npm SDK is used for server-side integration (decision D-12).
- Multiple concurrent orders per user are allowed (decision D-11) but must be handled with server-side safeguards to prevent abuse.

---

## 9. Open questions (deferred)

Only two questions remain open after the product/technical decisions in `00-context.md`. They do not block the start of implementation but must be resolved before go-live. Both require brainstorming in `02-implementation-plan.md`:

1. **Webhook event subset**: which Razorpay events to listen for. Candidates: `payment.captured`, `payment.failed`, `order.paid`. The prepaid credit model means we likely only need `payment.captured` (to credit the wallet) and `payment.failed` (for logging/alerting), but this needs thorough analysis against Razorpay's official webhook documentation.
2. **GST / tax invoicing**: whether to use Razorpay's Invoices API for compliant GST invoices or leave invoicing out of scope for v1. This depends on the business's tax obligations and should be decided with input from a tax advisor.

---

## 10. Recommended next step

The audit is complete and the major product/technical decisions are recorded in `00-context.md`. The next artifact is:

```
docs/features/razorpay/02-implementation-plan.md
```

That plan should:

1. **Resolve the two deferred questions** (webhook events, GST invoicing) via brainstorm and record the decisions.
2. **Define the credit-cost table**: exact credit cost per AI operation (code review, PR review, chat message) per model. This is the core business logic of the feature.
3. **Define free-credit grant amount**: how many credits on signup (enough for "a couple of reviews and chat messages").
4. **Break the work into small verifiable chunks** following the existing verification loop, each referencing findings in this audit by section/number.

Suggested chunk ordering (subject to revision after deferred questions are resolved):

1. **Branch hygiene** — bring `payment-integration` current with `main` (or `develop`, whichever is ahead).
2. **Prisma migration** — `PaymentOrder`, `PaymentEvent`, `CreditLedger`, `User.creditBalance`.
3. **`main.ts` raw-body change** — with smoke test of existing endpoints.
4. **Env-var rollout** — `RAZORPAY_*` added, `STRIPE_*` retired, `.env.example` + `docs/deployment.md` updated together.
5. **`PaymentsModule` skeleton** — module + DTOs + `ConfigService` wiring (no Razorpay calls yet).
6. **Razorpay SDK integration** — `PaymentsService` (order creation + webhook signature verification + credit crediting).
7. **Webhook endpoint** — signature verification + idempotent event processing.
8. **Credit-balance gate** — `CreditGuard` applied to `POST /review/session` and `POST /history/:id/chat`.
9. **Free-credit grant on signup** — hook into `UsersService.findOrCreate`.
10. **Client account page** — `/account` page + `useWallet` hook + Razorpay Checkout.js popup.
11. **Docs updates** — `data-model.md`, `architecture.md`, `deployment.md`, this directory.
12. **Tests + verification loop** — each chunk ships with tests; final chunk runs the full verification loop.

---

## Related files

| File | Role in this audit |
|---|---|
| [`AGENTS.md`](../../../AGENTS.md) | Monorepo conventions, safety rails, doc-trust map |
| [`docs/architecture.md`](../../architecture.md) | System component map |
| [`docs/authentication.md`](../../authentication.md) | GitHub OAuth, `AuthGuard`, `TokenCacheService` |
| [`docs/data-model.md`](../../data-model.md) | Prisma schema and migration rules |
| [`docs/deployment.md`](../../deployment.md) | Env-var reference (documents reserved `STRIPE_*`) |
| [`docs/frontend.md`](../../frontend.md) | Client App Router structure, API layer |
| [`docs/queue-streaming.md`](../../queue-streaming.md) | BullMQ + Redis Streams + "no auto-retry" rule |
| [`AI-CodeReview-SaaS-Masterplan.md`](../../../AI-CodeReview-SaaS-Masterplan.md) | Historical Stripe-based monetization intent |
| [`AUDIT-REPORT.md`](../../../AUDIT-REPORT.md) | A-24 / E-6 findings on reserved Stripe keys |
| [`apps/server/prisma/schema.prisma`](../../../apps/server/prisma/schema.prisma) | Schema being extended |
| [`apps/server/src/main.ts`](../../../apps/server/src/main.ts) | Bootstrap — raw-body change point |
| [`apps/server/src/app.module.ts`](../../../apps/server/src/app.module.ts) | Module registration point |
| [`apps/server/src/review/review.controller.ts`](../../../apps/server/src/review/review.controller.ts) | Credit-balance gate target |
| [`apps/server/src/history/history.controller.ts`](../../../apps/server/src/history/history.controller.ts) | Credit-balance gate target (chat) |
| [`apps/server/src/history/history.repository.ts`](../../../apps/server/src/history/history.repository.ts) | Usage-count pattern |
| [`apps/server/src/users/users.service.ts`](../../../apps/server/src/users/users.service.ts) | Free-credit grant hook point |
| [`apps/server/src/throttle/user-throttler.guard.ts`](../../../apps/server/src/throttle/user-throttler.guard.ts) | Per-user rate-limit pattern |
| [`apps/client/lib/api.ts`](../../../apps/client/lib/api.ts) | Client API wrapper to extend |
| [`apps/client/proxy.ts`](../../../apps/client/proxy.ts) | Auth-gate matcher to extend |
| [`apps/client/app/standards/page.tsx`](../../../apps/client/app/standards/page.tsx) | Account-page template |
| [`apps/client/components/layout/app-header.tsx`](../../../apps/client/components/layout/app-header.tsx) | Nav entry / credit balance location |
