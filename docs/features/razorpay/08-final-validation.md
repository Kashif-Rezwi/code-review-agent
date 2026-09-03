# Razorpay Feature — Final Validation and Handoff

> **Stage:** Final validation and handoff (read-only — no code was modified in this stage)
> **Date:** 2026-08-14
> **Validator stance:** Independent — this document was produced by re-reading every source file, migration, test, env template, and deployment doc, then cross-referencing the implementation against all seven prerequisite documents (`00`–`07`). The verification loop was re-executed to produce fresh evidence.
> **Purpose:** Allow a future agent to understand the Razorpay feature and its readiness without re-reading the entire implementation history. Every claim below is backed by a specific file/line citation or a freshly-run command.

---

## 0. How to read this document

Each verification item is tagged with one of four confidence labels:

| Label | Meaning |
|---|---|
| **✅ Verified** | Confirmed against the actual source code and/or a passing test in this validation run. |
| **🟡 Partially verified** | The control exists and is structurally correct, but some aspect could not be confirmed at the unit-test level (e.g. needs a real DB or sandbox). |
| **⬜ Not verified** | Could not be confirmed from static analysis or the test suite in this run. |
| **🔴 Requires manual production testing** | Cannot be validated without real Razorpay test-mode keys, a webhook tunnel, or a live Postgres instance — explicitly deferred to go-live. |

A consolidated readiness assessment appears in §12.

---

## 1. Final architecture summary

The Razorpay integration implements a **prepaid credit wallet** model (decision D-4) on top of the existing NestJS + Next.js monorepo. It replaces the masterplan's historical Stripe/subscription intent (which was never implemented).

### High-level flow

```
 Browser (Next.js /account)            NestJS API                        Razorpay
 ────────────────────────              ──────────                        ────────
 1. GET /payments/wallet ─────────────►│  (balance + ledger + packages)
 2. POST /payments/order  ─────────────►│  ── Orders.create() ───────────►│
     { packageId }                      │  ◄── { id, amount, currency } ──│
     ◄── { keyId, razorpayOrderId, … } ─│
 3. Razorpay Checkout.js popup (key_id from server, order_id from server)
     └── card/UPI payment ─────────────────────────────────────────────►│
                                                                        │
 4.                                  POST /payments/webhook ◄────────────│  (HMAC-SHA256 signed)
     │  verify signature → idempotent capture → credit wallet          │
 5. Poll GET /payments/wallet ─────────►│  (balance now increased)
```

### Components

| Layer | Component | Role |
|---|---|---|
| Server | `PaymentsModule` | New NestJS feature module (`apps/server/src/payments/`) |
| Server | `PaymentsController` | Authenticated `POST /payments/order`, `GET /payments/wallet` |
| Server | `WebhookController` | Unauthenticated `POST /payments/webhook` (HMAC-secured) |
| Server | `PaymentsService` | Razorpay SDK calls, HMAC verification, event routing, credit crediting |
| Server | `PaymentsRepository` | All DB mutations, atomic `$transaction` operations |
| Server | `CreditGuard` + `@CreditCost` | Pre-deducts credits before paid handlers (`/review/session`, `/history/:id/chat`) |
| Server | `CreditRefundInterceptor` | Refunds credits if a request fails after deduction but before handler completion (R-01) |
| Server | `credit-cost.policy.ts` | Server-side source of truth for packages, costs, free-credit amount |
| Client | `app/account/page.tsx` | Wallet UI + Razorpay Checkout.js popup |
| Client | `lib/use-wallet.ts` | Wallet polling hook (2 s interval, max 30 attempts) |
| Client | `lib/api.ts` → `paymentsService` | Typed `createOrder` / `getWallet` wrappers |
| Shared | `@cra/types` | `CreditPackageSchema`, `LedgerEntrySchema`, `WalletResponseSchema` (Zod) |
| DB | 2 additive migrations | `PaymentOrder`, `PaymentEvent`, `CreditLedger`, `User.creditBalance` + unique indexes |

**Verification: implementation matches documented architecture** — ✅ Verified
- All 3 endpoints from `02-architecture.md` §9 exist with the exact auth/rate-limit semantics documented.
- Credit packages (50/200/500 @ ₹99/₹349/₹799), costs (CODE=5, PR=10, CHAT=1), and free-credit amount (25) match `02-architecture.md` §6 and `03-implementation-plan.md`.
- Webhook event subset (`order.paid` + `payment.failed`) matches `02-architecture.md` §1.1.
- `docs/architecture.md:48` lists Razorpay as an external dependency.

---

## 2. Files/components involved

### Server — `apps/server/src/payments/`

| File | Purpose | Lines |
|---|---|---|
| `payments.controller.ts` | `POST /order`, `GET /wallet` (AuthGuard + throttler) | 39 |
| `payments.service.ts` | Razorpay SDK, HMAC verify, event routing, credit ops | 317 |
| `payments.repository.ts` | All DB mutations (atomic `$transaction`) | 367 |
| `payments.module.ts` | Module wiring (`forwardRef` for AuthModule) | 24 |
| `webhook.controller.ts` | `POST /webhook` (no auth guard, ThrottlerGuard) | 59 |
| `credit.guard.ts` | Pre-deduct credits, set refund markers | 93 |
| `credit-cost.policy.ts` | `CREDIT_PACKAGES`, `CREDIT_COSTS`, `FREE_CREDIT_AMOUNT` | 28 |
| `credit-cost.decorator.ts` | `@CreditCost()` metadata decorator | 16 |
| `credit-refund.interceptor.ts` | R-01 refund on pre-handler failure | 83 |
| `dto/create-order.dto.ts` | `packageId` validation (`@IsIn`) | 11 |

### Server — payments test files

| File | Tests | Coverage |
|---|---|---|
| `credit.guard.spec.ts` | 4 | CG-01 deduction, CG-03 402, F-06 resolver strictness, no-user 500 |
| `free-credit.spec.ts` | 2 | Grant on signup, F-15 error handling |
| `payments.repository.spec.ts` | 13 | S-02 amount fail-closed, S-05 currency, capture, already-captured, not-found, R-02 zero-credits, S-01 P2002 race, findFirst fast-path, refund |
| `payments.service.spec.ts` | 9 | WH-01 valid HMAC, invalid sig, malformed sig, duplicate event, S-05 currency, R-08 non-object (null+string), F-11 pending cap |
| `webhook.controller.spec.ts` | 4 | Missing/invalid sig, F-03 payload too large, F-08 event-id missing, delegation |

### Server — touchpoints outside `payments/`

| File | Change |
|---|---|
| `src/main.ts` | `{ rawBody: true }` in `NestFactory.create` (F-01 prerequisite) |
| `src/app.module.ts` | `PaymentsModule` registered |
| `src/auth/auth.guard.ts` | `?token=` fallback excluded for `/payments/` routes (R-07) |
| `src/review/review.controller.ts` | `CreditGuard` + `@CreditCost` + `CreditRefundInterceptor` on `POST /session` |
| `src/review/review.repository.ts` | `markFailedAndRefund()` — atomic status-guard + refund (S-06) |
| `src/history/history.controller.ts` | `CreditGuard` + `@CreditCost` + `CreditRefundInterceptor` on `POST /:id/chat` |
| `src/users/users.service.ts` | `grantFreeCredits()` on signup (F-15) |
| `src/users/users.module.ts` | Imports `PaymentsModule` |

### Database

| File | Content |
|---|---|
| `prisma/schema.prisma` | `User.creditBalance`, `PaymentOrder`, `PaymentEvent`, `CreditLedger`, `OrderStatus` + `LedgerEntryType` enums |
| `prisma/migrations/20260813172114_add_payment_credit_models/migration.sql` | Tables + indexes + FKs (additive) |
| `prisma/migrations/20260814000000_add_credit_ledger_unique_indexes/migration.sql` | Partial unique indexes (S-01, S-06) (additive) |

### Client

| File | Role |
|---|---|
| `app/account/page.tsx` | Wallet dashboard + Razorpay Checkout.js popup |
| `lib/use-wallet.ts` | `useWallet` hook (fetch + poll) |
| `lib/api.ts` | `paymentsService.createOrder` / `getWallet` |
| `lib/use-wallet.spec.ts` | 2 client tests (fetch on mount, polling lifecycle) |

### Shared & Config

| File | Role |
|---|---|
| `packages/types/src/index.ts` | `CreditPackageSchema`, `LedgerEntrySchema`, `WalletResponseSchema` + TS types |
| `apps/server/.env.example` | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (+ R-06 comment) |
| `apps/client/.env.example` | R-06 comment (no `NEXT_PUBLIC_RAZORPAY_KEY_ID`) |
| `render.yaml` | `RAZORPAY_*` secrets (`sync: false`) |
| `docs/deployment.md` | `RAZORPAY_*` in Render env table; Vercel Razorpay note |
| `docs/data-model.md` | `PaymentOrder`, `PaymentEvent`, `CreditLedger`, `creditBalance` documented |

**Verification: implementation matches the final plan** — ✅ Verified
- All 11 chunks from `03-implementation-plan.md` are marked executed in `04-implementation.md`.
- Security hardening S-01–S-06 (`05-security-hardening.md`) and remediation R-01–R-08 (`07-remediation.md`) are reflected in the code.
- The git log (`payment-integration` branch) confirms the implementation, hardening, review, and remediation commits.

---

## 3. Payment lifecycle

```
                  ┌──────────────────────────────────────────────────────┐
                  │                  PaymentOrder state machine          │
                  └──────────────────────────────────────────────────────┘

  POST /payments/order                   Razorpay webhook: order.paid
  ────────────────────                   ─────────────────────────────────
  1. Validate packageId (DTO @IsIn)      1. HMAC-SHA256 verify (raw body)
  2. Count pending CREATED orders        2. Dedup by razorpayEventId
     (F-11: reject if ≥ 3 → 429)         3. Load local order
  3. Razorpay.orders.create()            4. Cross-check amount (F-09)
  4. Persist PaymentOrder ──────►  CREATED  5. Cross-check currency (S-05)
     creditsGranted = pkg.credits        6. Fail-closed if creditsGranted ≤ 0 (R-02)
                                          7. Status-guard CREATED → CAPTURED
  Razorpay webhook: payment.failed          8. increment User.creditBalance
  ──────────────────────────────────        9. insert CreditLedger (PURCHASE)
  1. HMAC-SHA256 verify               ────►  CAPTURED
  2. Status-guard CREATED → FAILED
                                      ────►  FAILED
```

| Step | Code location | Verified |
|---|---|---|
| Order creation | `payments.service.ts:45-95`, `payments.controller.ts:23-30` | ✅ |
| Pending cap (F-11) | `payments.service.ts:51-57`, `payments.repository.ts:361-366` | ✅ (test: `payments.service.spec.ts` F-11) |
| Credits persisted at creation (R-02) | `payments.service.ts:85`, `payments.repository.ts:19` | ✅ (test: `payments.repository.spec.ts` R-02) |
| Razorpay SDK error sanitisation (F-10) | `payments.service.ts:70-75` | ✅ |
| Atomic capture | `payments.repository.ts:39-130` (`captureOrder`) | ✅ (13 repository tests) |
| Amount cross-check (F-09) | `payments.repository.ts:88-104` | ✅ (tests: amount_mismatch missing + wrong) |
| Currency cross-check (S-05) | `payments.repository.ts:106-117` | ✅ (test: S-05 USD mismatch) |
| Zero-credit fail-closed (R-02) | `payments.repository.ts:72-91` | ✅ (test: R-02 zero_credits) |
| Wallet query | `payments.service.ts:244-264` | ✅ |
| Free credit grant (F-15) | `users.service.ts:42-47`, `payments.repository.ts:284-320` | ✅ (2 free-credit tests) |

**Verification: payment flow is complete** — ✅ Verified (unit level)
The full lifecycle — order creation → checkout → webhook capture → wallet credit → polling — is implemented end to end. The only unverified step is the **real Razorpay API call** (see §8).

---

## 4. Webhook lifecycle

```
 Razorpay ──POST──► /payments/webhook
                      │
                      ▼
  ┌─ WebhookController ──────────────────────────────────────────┐
  │ 1. ThrottlerGuard: 100/min per IP (R-03)                     │
  │ 2. rawBody present? → else 413 if > 1 MB (F-03)             │
  │ 3. X-Razorpay-Signature: present + 64 hex? → else 401 (F-02)│
  │ 4. x-razorpay-event-id: present + ≤ 128 chars? → else 400   │
  │ 5. → PaymentsService.handleWebhook(rawBody, sig, eventId)   │
  └───────────────────────────────────────────────────────────────┘
                      │
                      ▼
  ┌─ PaymentsService.handleWebhook ──────────────────────────────┐
  │ 1. Re-validate sig format (64 hex) — prevents RangeError     │
  │ 2. HMAC-SHA256(webhookSecret, rawBody) → hex                 │
  │ 3. crypto.timingSafeEqual(expected, received) — constant time│
  │    mismatch → throw UnauthorizedException (401)              │
  │ 4. JSON.parse(rawBody) — AFTER signature verified            │
  │ 5. R-08: typeof parsed !== 'object' || null → warn + return  │
  │ 6. Route by event.event:                                     │
  │    'order.paid'      → handleOrderPaid()                      │
  │    'payment.failed'  → handlePaymentFailed()                 │
  │    other             → debug log, ignore                     │
  └───────────────────────────────────────────────────────────────┘
                      │
                      ▼
  ┌─ handleOrderPaid → captureOrder (single $transaction) ───────┐
  │ 1. INSERT PaymentEvent (unique razorpayEventId = idempotency)│
  │    P2002 → 'duplicate' (ack 200, no-op)                      │
  │ 2. SELECT local PaymentOrder by razorpayOrderId              │
  │    not found → 'not_found' (error log, no credits)           │
  │ 3. creditsGranted ≤ 0 → 'zero_credits' (R-02, error log)     │
  │ 4. amountPaidPaise != localOrder.amountPaise → 'amount_mismatch'│
  │    (F-09, record mismatch event, no credits)                 │
  │ 5. currency mismatch → 'amount_mismatch' (S-05)              │
  │ 6. UPDATE PaymentOrder status CREATED→CAPTURED (status-guard)│
  │    count=0 → 'already_captured'                              │
  │ 7. UPDATE User.creditBalance += creditsGranted               │
  │ 8. INSERT CreditLedger (PURCHASE, balanceAfter from DB)      │
  │ → 'captured'                                                 │
  └───────────────────────────────────────────────────────────────┘
```

| Control | Finding | Code | Verified |
|---|---|---|---|
| Raw body used for HMAC (F-01) | ✅ | `payments.service.ts:110-119` | ✅ (test WH-01) |
| Sig format pre-check (F-02) | ✅ | `webhook.controller.ts:47`, `payments.service.ts:106` | ✅ (tests WH-05/WH-06) |
| Body size limit (F-03) | ✅ | `webhook.controller.ts:42`, `payments.service.ts:21` | ✅ (test F-03) |
| Event ID validation (F-08) | ✅ | `webhook.controller.ts:52` | ✅ (test F-08) |
| Parse after verify | ✅ | `payments.service.ts:124` (parse is after the `isValid` check at line 120) | ✅ |
| Non-object guard (R-08) | ✅ | `payments.service.ts:131-134` | ✅ (2 R-08 tests) |
| Idempotency (dedup) | ✅ | `payments.repository.ts:52-61` (unique constraint) + `payments.service.ts:183-187` (P2002 catch) | ✅ (test WH-09) |
| Rate limit (R-03) | ✅ | `webhook.controller.ts:33-34` | ✅ (spec imports ThrottlerModule) |

**Verification: webhook flow is complete** — ✅ Verified (unit level)
The webhook path is the authoritative credit source (decision D-9). All security controls are implemented and unit-tested. The signature verification is correctly applied **before** any parsing or processing.

---

## 5. Security controls

### 5.1 Signature verification

| Property | Status | Evidence |
|---|---|---|
| HMAC-SHA256 over raw body Buffer (never stringified) | ✅ Verified | `payments.service.ts:110-114` + test WH-01 |
| `crypto.timingSafeEqual` (constant-time comparison) | ✅ Verified | `payments.service.ts:116-119` |
| Signature verified before JSON.parse | ✅ Verified | parse at line 127, verify at lines 110-122 |
| Format pre-check prevents `RangeError` on length mismatch | ✅ Verified | `payments.service.ts:106` + tests WH-05/WH-06 |
| Webhook secret from `getOrThrow` (fails fast if missing) | ✅ Verified | `payments.service.ts:37` |

### 5.2 Authorization

| Endpoint | Auth | Rate limit | Verified |
|---|---|---|---|
| `POST /payments/order` | `AuthGuard` (class-level) | `UserThrottlerGuard` 5/hr | ✅ |
| `GET /payments/wallet` | `AuthGuard` (class-level) | `UserThrottlerGuard` 60/min (F-12/R-05) | ✅ |
| `POST /payments/webhook` | None (HMAC only) | `ThrottlerGuard` 100/min/IP (R-03) | ✅ |
| `POST /review/session` | `AuthGuard` + `CreditGuard` | `UserThrottlerGuard` 10/hr | ✅ |
| `POST /history/:id/chat` | `AuthGuard` + `CreditGuard` | `UserThrottlerGuard` 60/hr | ✅ |

- `?token=` query-param auth fallback is **excluded** for `/payments/` routes (R-07): `auth.guard.ts:34-35`.
- `CreditGuard` requires `AuthGuard` to run first (throws 500 if `req.user` missing): `credit.guard.ts:66-69`.

### 5.3 Payment state not trusted from the client

| Control | Status | Evidence |
|---|---|---|
| `userId` always from `req.user` (AuthGuard), never from body | ✅ Verified | `payments.controller.ts:29`, `payments.controller.ts:37` |
| Amount/currency from server-side `CREDIT_PACKAGES`, never from client | ✅ Verified | `payments.service.ts:64-66`, `credit-cost.policy.ts:3-10` |
| `creditsGranted` persisted at creation, read from local order at capture (R-02) | ✅ Verified | `payments.service.ts:85`, `payments.repository.ts:19, 72` |
| No client-side verify endpoint (D-9) | ✅ Verified | only `order` + `wallet` + `webhook` endpoints exist |
| Webhook amount cross-check vs local order (F-09) | ✅ Verified | `payments.repository.ts:88-104` |
| No endpoint mutates `creditBalance`/`CreditLedger` from client input | ✅ Verified | all mutations are server-initiated in `PaymentsRepository` |

### 5.4 Credit consumption & refunds

| Control | Status | Evidence |
|---|---|---|
| Atomic conditional decrement (`gte` anti-double-spend) | ✅ Verified | `payments.repository.ts` `deductCredits` (`updateMany` with `gte` guard) |
| `balanceAfter` read from DB, never computed (F-04) | ✅ Verified | all ledger inserts use `findUniqueOrThrow` after `updateMany` |
| Handler-failure refund (S-03 review / S-04 chat) | ✅ Verified | `review.controller.ts:47-65`, `history.controller.ts:71-87` |
| Pipe-level 400 refund (R-01) | ✅ Verified | `credit-refund.interceptor.ts` + `review.controller.spec.ts` R-01 tests |
| Double-refund prevention (R-01 marker clearing) | ✅ Verified | `review.controller.ts:61-64`, `history.controller.ts:84-86`, interceptor clears markers |
| Review-level refund via `markFailedAndRefund` (S-06) | ✅ Verified | `review.repository.ts:61-122` (status-guard + findFirst + P2002 catch) |

### 5.5 Secrets

| Secret | Exposure | Verified |
|---|---|---|
| `RAZORPAY_KEY_SECRET` | Server-only, `getOrThrow`, never returned to client | ✅ Verified |
| `RAZORPAY_WEBHOOK_SECRET` | Server-only, `getOrThrow`, never returned to client | ✅ Verified |
| `RAZORPAY_KEY_ID` | Publishable — returned to client via `createOrder` response (by design) | ✅ Verified |
| SDK error sanitisation (F-10) | Raw error object not logged; only `err.message` | ✅ Verified (`payments.service.ts:71-73`) |
| No PII in Razorpay notes (F-10) | `notes: { packageId }` only — no userId | ✅ Verified (`payments.service.ts:68`) |

**Verification: security controls** — ✅ Verified (unit level)
No Critical or High findings remain per the independent security review (`06-security-review.md` §6). All R-01–R-08 findings are remediated and tested.

---

## 6. Database changes

### Schema additions (`schema.prisma`)

| Model/Field | Purpose |
|---|---|
| `User.creditBalance Int @default(0)` | Prepaid wallet balance |
| `OrderStatus` enum | `CREATED`, `CAPTURED`, `FAILED`, `EXPIRED` |
| `LedgerEntryType` enum | `FREE_GRANT`, `PURCHASE`, `CONSUMPTION`, `CONSUMPTION_REFUND` |
| `PaymentOrder` | Tracks Razorpay checkout sessions |
| `PaymentEvent` | Webhook event log + idempotency (`razorpayEventId @unique`) |
| `CreditLedger` | Append-only audit log of all credit mutations |

### Migrations (both additive — baseline untouched per safety rail #1)

| Migration | Content |
|---|---|
| `20260813172114_add_payment_credit_models` | Tables, enums, `creditBalance`, indexes, FKs |
| `20260814000000_add_credit_ledger_unique_indexes` | Partial unique indexes for S-01 (at-most-one FREE_GRANT/user) and S-06 (at-most-one CONSUMPTION_REFUND/review) |

### Consistency guarantees

| Guarantee | Mechanism | Verified |
|---|---|---|
| Atomic credit mutations | All writes inside `$transaction` | ✅ Verified |
| No double-credit on duplicate webhook | `PaymentEvent.razorpayEventId` unique constraint + P2002 catch | ✅ Verified (test WH-09) |
| No double-free-grant on concurrent signup | Partial unique index `(userId, type) WHERE type='FREE_GRANT'` + findFirst + P2002 catch | 🟡 Partially (unit test mocks P2002; real concurrent-DB race not tested) |
| No double-refund on review failure | Status-guard `PENDING→FAILED` + findFirst + partial unique index `(reviewId, type) WHERE type='CONSUMPTION_REFUND' AND reviewId IS NOT NULL` + P2002 catch | 🟡 Partially (unit test mocks P2002; real concurrent-DB race not tested) |
| Anti-double-spend on consumption | `updateMany` with `creditBalance: { gte: cost }` guard | 🟡 Partially (mocked; needs real DB to confirm atomicity) |
| `balanceAfter` accuracy | Read from DB via `findUniqueOrThrow` after every increment (F-04) | ✅ Verified |
| Status-guard transitions | `updateMany` with `where: { status: 'CREATED' }` (capture) / `{ status: 'PENDING' }` (refund) | ✅ Verified |

**Verification: database state is consistent** — 🟡 Partially verified
All consistency mechanisms are correctly implemented and unit-tested with mocks. Concurrency safety under real Postgres load (S-01, S-06, anti-double-spend) requires integration testing against a real database — explicitly listed as a remaining limitation in `07-remediation.md`.

---

## 7. Environment variables

| Variable | Where set | Documented? | Verified |
|---|---|---|---|
| `RAZORPAY_KEY_ID` | Server `.env` / Render dashboard | ✅ `server/.env.example`, `docs/deployment.md`, `render.yaml` | ✅ Verified |
| `RAZORPAY_KEY_SECRET` | Server `.env` / Render dashboard (server-only) | ✅ same locations | ✅ Verified |
| `RAZORPAY_WEBHOOK_SECRET` | Server `.env` / Render dashboard (server-only) | ✅ same locations | ✅ Verified |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | **Removed** (R-06) | ✅ `.env.example` has explanatory comment; `docs/deployment.md` has Razorpay note | ✅ Verified (no code reads it) |

- `PaymentsService` uses `config.getOrThrow` for all three secrets — the server **fails to boot** if any is missing.
- `render.yaml` declares all three as `sync: false` (set in dashboard, never committed).
- **Minor doc inconsistency:** `docs/deployment.md` lines 258–273 still list `STRIPE_*` keys in a "reserved / not implemented" reference table. The `.env.example` files no longer contain them. These are clearly marked "Not implemented — reserved" and are not in the active required-env-vars table, so they are not misleading — but they are stale leftovers from the pre-Razorpay era.

**Verification: environment variables are documented** — ✅ Verified (with minor stale STRIPE_ note above)

---

## 8. Tests/checks performed

### Fresh verification loop (executed in this validation run — 2026-08-14)

| Step | Command | Result |
|---|---|---|
| 1. Build shared packages | `pnpm build:packages` | ✅ Pass (`@cra/types` + `@cra/ai` built) |
| 2. Type-check (all 4 projects) | `pnpm type-check` | ✅ Pass (0 errors) |
| 3. Server unit tests | `pnpm --filter server test` | ✅ Pass — **31 suites, 152 tests** |
| 4. Client unit tests | `pnpm --filter client test` | ✅ Pass — **10 files, 16 tests** |
| 5. Lint | `pnpm lint` | ✅ Pass (exit 0) |

### Payment-specific test coverage

| Suite | Tests | What they cover |
|---|---|---|
| `payments.service.spec.ts` | 9 | HMAC signature verification (valid/invalid/malformed), duplicate event dedup, currency extraction (S-05), non-object body (R-08 × 2), pending order cap (F-11) |
| `payments.repository.spec.ts` | 13 | Amount fail-closed (S-02 × 2), currency mismatch (S-05), successful capture, already-captured, not-found, zero-credits (R-02), P2002 race (S-01), findFirst fast-path, non-P2002 rethrow, refund |
| `credit.guard.spec.ts` | 4 | Successful deduction, 402 insufficient, F-06 strict resolver, no-user 500 |
| `webhook.controller.spec.ts` | 4 | Missing/invalid signature, payload too large (F-03), event-id missing (F-08), delegation |
| `free-credit.spec.ts` | 2 | Grant on signup, F-15 error handling |
| `use-wallet.spec.ts` (client) | 2 | Fetch on mount, polling lifecycle |
| `review.controller.spec.ts` | (updated) | Handler-failure refund (S-03), R-01 pipe-level 400 refund, R-01 valid-201 no-refund |

### What is NOT tested

| Gap | Why | Risk |
|---|---|---|
| Real Razorpay API call (order creation) | Requires test-mode API keys | 🔴 Requires manual production testing |
| Real Razorpay webhook delivery | Requires webhook tunnel + test-mode payment | 🔴 Requires manual production testing |
| Concurrent DB races (S-01, S-06, double-spend) | Requires real Postgres with concurrent connections | 🟡 Partially verified (mocked) |
| Guard→deduct→refund chain vs real DB | Requires real Postgres | 🟡 Partially verified (supertest level only) |
| Raw body integrity through Express 5 + Nest 11 | Needs runtime smoke test | 🟡 `{ rawBody: true }` is set but not runtime-tested in CI |

**Verification: tests/checks have been executed** — ✅ Verified (full loop green this run)
The unit-test suite is comprehensive for payment-critical paths. Integration/E2E gaps are explicitly documented as remaining limitations.

---

## 9. Known limitations

These are documented in `07-remediation.md` (§"Remaining limitations") and `06-security-review.md` (§"Pre-go-live checklist"), and confirmed present in this validation:

| # | Limitation | Impact | Recommended action |
|---|---|---|---|
| L-1 | No metrics/alerting infrastructure (R-04) | `amount_mismatch`, `not_found`, `zero_credits` errors are logged at `error` level but nothing alerts on them | Configure external log aggregation to alert on `error`-level logs containing `[R-02]`, `[F-09]`, `zero_credits`, `not_found`, `amount_mismatch` |
| L-2 | No reconciliation job for stranded `CREATED` orders | Orders stuck in `CREATED` (e.g. webhook missed + Razorpay retry exhausted) never auto-resolve | Before go-live, add a scheduled process to re-fetch Razorpay orders `CREATED` for > 1 hour |
| L-3 | `?token=` auth fallback not fully removed (R-07) | Excluded for `/payments/` routes but still active for all other routes | Monitor logs for `?token=` usage; remove entirely once usage is zero |
| L-4 | DB-level race conditions not verified under load (S-01, S-06) | Partial unique indexes are in place but never exercised against real concurrent Postgres transactions | Integration test with real Postgres + concurrent connections before go-live |
| L-5 | Guard→refund chain not E2E tested against real DB (R-01) | The interceptor refund logic is tested at supertest level only | E2E test with supertest + real Postgres before go-live |
| L-6 | Razorpay sandbox E2E never run | No test-mode payment → webhook → credit flow has been executed end to end | Manual test per production deployment checklist (`03-implementation-plan.md` §"Production deployment checklist") |
| L-7 | `{ rawBody: true }` not runtime-verified in CI | The Express 5 + Nest 11 raw-body option is configured but no automated test confirms `req.rawBody` is populated for the webhook route | Add a runtime smoke test or manual verification before go-live |
| L-8 | Stale `STRIPE_*` entries in `docs/deployment.md` reserved table | Minor doc inconsistency — `.env.example` files no longer have them | Remove the `STRIPE_*` rows from the deployment env reference (low priority) |
| L-9 | No GST/tax invoicing (D-14 / architecture §1.2) | By design — deferred until GST registration confirmed | Future feature chunk with its own migration when needed |
| L-10 | No order expiry handling | `EXPIRED` status exists in the enum but no code transitions to it | Razorpay auto-expires orders after ~10 min; add a cleanup job or rely on L-2 reconciliation |

**Verification: known limitations are documented** — ✅ Verified

---

## 10. Deployment requirements

### Pre-deployment (server — Render)

1. **Prisma migration deploy:** `cd apps/server && npx prisma migrate deploy`
   - Both payment migrations (`20260813172114`, `20260814000000`) must be applied.
   - ✅ Verified: migrations are additive and the baseline (`20260301000000`) is untouched.
2. **Environment variables** (Render dashboard — `render.yaml` declares them as `sync: false`):
   - `RAZORPAY_KEY_ID` — Razorpay Key ID (publishable)
   - `RAZORPAY_KEY_SECRET` — Razorpay Key Secret (server-only)
   - `RAZORPAY_WEBHOOK_SECRET` — Razorpay Webhook Secret (server-only)
   - ✅ Verified: `PaymentsService` uses `getOrThrow` — server will not boot without all three.
3. **Razorpay Dashboard configuration:**
   - Create test-mode + live-mode accounts.
   - Generate API keys (Key ID + Key Secret).
   - Register webhook URL: `https://<api-url>/payments/webhook`
   - Subscribe to events: `order.paid`, `payment.failed`
   - Copy the Webhook Secret → set as `RAZORPAY_WEBHOOK_SECRET`.
   - Ensure **auto-capture is enabled** (the default; architecture §1.1 depends on it).
   - 🔴 Requires manual production testing — not verifiable from code alone.

### Pre-deployment (client — Vercel)

4. No Razorpay-specific env var needed on Vercel (R-06 — `key_id` is delivered via the server's `createOrder` response).
   - ✅ Verified: `account/page.tsx:55` uses `orderData.keyId` from the server response.
5. `NEXT_PUBLIC_API_URL` must point to the Render API URL (already required pre-feature).

### Post-deployment (E2E validation)

6. Create order → pay via Razorpay test card → verify webhook received → verify credit balance increased by exactly the package's `creditsGranted`.
7. Verify duplicate webhook delivery is no-oped (credits granted once).
8. Verify insufficient-credits flow returns 402 on `/review/session`.
9. Switch to live mode: update API keys + webhook URL in Razorpay Dashboard and env vars.
10. Remove any `STRIPE_*` entries from Render/Vercel dashboards if previously set.

### Branch strategy (per D-13)

`payment-integration` → merge to `develop` → merge to `main` (Render auto-deploys from `main`).

**Verification: deployment requirements** — ✅ Verified (documented); 🔴 E2E steps require manual execution.

---

## 11. Future improvements

| # | Improvement | Rationale |
|---|---|---|
| F-1 | **Webhook signature replay-window check** | Razorpay includes `x-razorpay-timestamp` — adding a ±5 min window check would harden against delayed replay (currently mitigated by idempotency keys + order status-guards) |
| F-2 | **Reconciliation cron for stranded `CREATED` orders** | Addresses L-2 — re-fetch Razorpay orders stale > 1 hour, capture or expire locally |
| F-3 | **Order expiry transition** | The `EXPIRED` enum value exists but is never set; wire it to the reconciliation job |
| F-4 | **Metrics/alerting integration** | Addresses L-1 — pipe `error`-level payment logs to an alerting system (Sentry, Datadog, etc.) |
| F-5 | **Integration test suite with real Postgres** | Addresses L-4/L-5 — verify S-01/S-06 race conditions and the guard→refund chain against a real DB |
| F-6 | **Client-side 402 UX** | Architecture §8.3 describes an "Insufficient credits" message + link to Account page; verify the review/chat pages surface this cleanly |
| F-7 | **Remove `?token=` fallback entirely** | Addresses L-3 — once log monitoring confirms zero usage |
| F-8 | **GST/tax invoicing** | Addresses L-9 — when GST registration is confirmed, add a `TaxInvoice` model + Razorpay Invoices API integration |
| F-9 | **Webhook signature test in CI** | Addresses L-7 — add a runtime smoke test that confirms `req.rawBody` is populated through Express 5 + Nest 11 |
| F-10 | **Credit cost configurability via DB/env** | Currently hardcoded in `credit-cost.policy.ts`; making it env-driven would allow tuning without redeploy |

---

## 12. Final readiness assessment

### Summary table

| Requirement | Status |
|---|---|
| Implementation matches documented architecture | ✅ Verified |
| Implementation matches the final plan | ✅ Verified |
| Payment flow is complete | ✅ Verified (unit level) |
| Webhook flow is complete | ✅ Verified (unit level) |
| Signature verification exists and is correctly applied | ✅ Verified |
| Idempotency exists where required | ✅ Verified (unit level) |
| Authorization is enforced | ✅ Verified |
| Payment state cannot be trusted from the client | ✅ Verified |
| Database state is consistent | 🟡 Partially verified (needs real-DB integration tests) |
| Environment variables are documented | ✅ Verified (minor stale STRIPE_ note) |
| Tests/checks have been executed | ✅ Verified (full loop green this run) |
| Known limitations are documented | ✅ Verified |

### Verification loop results (this run, 2026-08-14)

| Check | Result |
|---|---|
| `pnpm build:packages` | ✅ Pass |
| `pnpm type-check` (4 projects) | ✅ Pass (0 errors) |
| `pnpm --filter server test` | ✅ Pass (31 suites, 152 tests) |
| `pnpm --filter client test` | ✅ Pass (10 files, 16 tests) |
| `pnpm lint` | ✅ Pass (exit 0) |

### Items that require manual production testing (🔴)

1. **Real Razorpay test-mode payment → webhook → credit grant** — the core happy path has never been executed against the real Razorpay API. This is the single most important pre-go-live gate.
2. **Webhook URL registration + event subscription** in the Razorpay Dashboard (cannot be done from code).
3. **Auto-capture confirmation** in the Razorpay Dashboard (architecture depends on it).
4. **Duplicate webhook delivery idempotency** against real Razorpay retries.

### Items partially verified (🟡 — need integration testing)

1. **Concurrent DB race conditions** (S-01 free-grant, S-06 refund, anti-double-spend) — partial unique indexes are in place; P2002 catches are unit-tested with mocks; real concurrent Postgres transactions are not exercised.
2. **Guard→deduct→refund chain against real Postgres** (R-01) — tested at supertest level with mocked repo.
3. **`req.rawBody` population through Express 5 + Nest 11** — configured but not runtime-verified in CI.

### Overall readiness

**The Razorpay feature is ready for continued development and pre-production testing. It is NOT yet production-ready.**

The implementation is **architecturally complete**, **security-hardened** (three review passes: design F-01–F-16, code-level S-01–S-06, independent R-01–R-08, all remediated), and **green on the full monorepo verification loop** (build, type-check, 168 tests, lint). The codebase has no Critical or High security findings outstanding.

However, **production readiness is blocked** on the following manual gates that cannot be satisfied from static analysis or unit tests alone:

1. A successful end-to-end Razorpay sandbox payment (test card → webhook → credit grant → wallet poll).
2. Integration tests against a real Postgres instance confirming the concurrency safety of free-grant, refund, and double-spend guards.
3. Razorpay Dashboard configuration (webhook URL, event subscription, auto-capture, webhook secret).
4. A runtime smoke test confirming `req.rawBody` is populated for the webhook route.

Until those four items are completed and verified, the feature should be treated as **implementation-complete, pending production validation**.

---

## Related files

| File | Role |
|---|---|
| [`00-context.md`](./00-context.md) | Feature context, decisions D-1–D-14 |
| [`01-audit.md`](./01-audit.md) | Repository audit, design-phase findings F-01–F-16 |
| [`02-architecture.md`](./02-architecture.md) | System design, payment/webhook flow, DB schema, security model |
| [`03-implementation-plan.md`](./03-implementation-plan.md) | 11-chunk file-by-file implementation plan |
| [`04-implementation.md`](./04-implementation.md) | Execution log for all 11 chunks + remediation |
| [`05-security-hardening.md`](./05-security-hardening.md) | Code-level security pass, findings S-01–S-06 |
| [`06-security-review.md`](./06-security-review.md) | Independent security review, findings R-01–R-08 |
| [`07-remediation.md`](./07-remediation.md) | Remediation of R-01–R-08 + remaining limitations |
| `apps/server/src/payments/*` | All payment module source + tests |
| `apps/server/prisma/migrations/20260813*` + `20260814*` | Two additive DB migrations |
| `apps/client/app/account/page.tsx`, `lib/use-wallet.ts`, `lib/api.ts` | Client checkout + wallet UI |
| `packages/types/src/index.ts` | Shared Zod contracts for wallet response |
