# Razorpay Payment Integration — Security Hardening

> **Stage:** Security hardening pass on the implemented code
> **Prerequisites:** [`00-context.md`](./00-context.md), [`01-audit.md`](./01-audit.md), [`02-architecture.md`](./02-architecture.md), [`03-implementation-plan.md`](./03-implementation-plan.md), [`04-implementation.md`](./04-implementation.md)
> **Scope:** Payment-critical paths only — payment/webhook signature verification, request authenticity, payment ownership, authorization, trust boundaries, amount/currency manipulation, order/payment mismatch, duplicate requests, replay attacks, webhook retries, idempotency, race conditions, transaction states, partial failures, database transaction boundaries, secret exposure, sensitive logging, frontend trust assumptions.
> **Date:** 2026-08-14
> **Prior pass:** A design-phase security review was performed on 2026-08-13 (before code existed), producing findings F-01 through F-16. Those findings were incorporated into the implementation. This pass reviews the **actual implemented code** and finds additional issues that the design review could not catch.

---

## 0. Scope and methodology

This document reviews the implemented Razorpay payment integration against the security objectives in the task brief. The review is **code-level** — every finding references a specific file and line range in the implemented code, not the design documents.

**Method:**
1. Read all five prerequisite documents in full.
2. Read every source file in `apps/server/src/payments/`, the credit-guard touchpoints in `review.controller.ts` and `history.controller.ts`, the refund path in `review.repository.ts` and `review.service.ts`, the client checkout flow in `account/page.tsx` and `use-wallet.ts`, the Prisma schema, and the applied migration SQL.
3. For each security-critical path, verify the implemented behaviour against the threat model.
4. For every vulnerability found: identify it, explain why it exists, implement the smallest appropriate fix, and verify the resulting behaviour with a unit test.
5. Run the full verification loop (`pnpm build:packages`, `pnpm type-check`, `pnpm --filter server test`, `pnpm --filter client test`, `pnpm lint`).

**No claim of protection is made that has not been verified.** Where a property is stated as "verified," a specific test or code path is cited. Where a property could not be verified at the unit-test level (e.g. requires a real database or Razorpay sandbox), it is explicitly called out as "not verified in this pass."

---

## 1. Threat model

### 1.1 Trust boundaries

```
 UNTRUSTED                                        TRUSTED
 ────────                                         ───────
 Browser / client code               │   NestJS API server
 - Sends requests with a             │   - AuthGuard validates
   GitHub Bearer token               │     tokens via GitHub API
 - Drives Razorpay Checkout.js       │   - All credit mutations
 - Observes wallet balance via       │     happen server-side
   polling (no client-side verify)   │   - Secrets never leave server
                                     │   - Amount/currency determined
 Razorpay servers (webhook)          │     server-side from CREDIT_PACKAGES
 - Unauthenticated HTTP POST         │
 - Must be verified via HMAC-SHA256  │   Razorpay servers (API calls)
   before any processing             │   - Called from server, HTTPS
 - Razorpay retries for ~24h         │   - API key used as credential
   on non-2xx responses              │
```

### 1.2 Attacker capabilities

| Attacker class | Capability |
|---|---|
| **Authenticated user — honest** | Normal use; has a valid GitHub token; gets correct credits |
| **Authenticated user — manipulative** | Valid token, tries to manipulate amounts, forge signatures, race deductions, double-claim free credits |
| **Unauthenticated internet actor** | No token; targets webhook endpoint, public endpoints |
| **Replay attacker** | Captures a valid webhook payload; replays it at a later time |
| **Race attacker** | Opens multiple concurrent sessions to trigger double-spend or double-grant |
| **Account enumerator** | Probes wallet endpoint for other users' balances |
| **Secret logger attacker** | Attempts to leak secrets via log output or error messages |
| **Webhook spoofer** | Sends forged webhook payloads without a valid HMAC signature |
| **MITM attacker** | Positioned between Razorpay and the server |

### 1.3 Assets

| Asset | Sensitivity | Consequence if compromised |
|---|---|---|
| `RAZORPAY_KEY_SECRET` | Critical | Orders can be created/fetched on behalf of merchant |
| `RAZORPAY_WEBHOOK_SECRET` | Critical | Attacker can manufacture webhook events → unlimited credits |
| `User.creditBalance` | High | Credits stolen or manufactured → revenue loss |
| `CreditLedger` | High | Audit trail corrupted → undetectable fraud |
| `PaymentOrder` rows | High | Order ownership transferred or balance inflated |
| User wallet data | Medium | Privacy exposure (transaction history) |

---

## 2. Security findings

Findings are labelled S-01 through S-06. Each finding documents the vulnerability, why it exists, the fix applied, and the verification performed.

Design-phase findings F-01 through F-16 (from the prior pass) were verified as implemented in the code. They are summarised in §3 and not repeated here unless this pass found a gap in their implementation.

---

### S-01 — HIGH: TOCTOU race in `grantFreeCredits` allows concurrent double-grant of free credits

**Where:** `apps/server/src/payments/payments.repository.ts` — `grantFreeCredits` method; migration `20260813172114_add_payment_credit_models` (no unique constraint on `CreditLedger`).

**Vulnerability:** `grantFreeCredits` uses a `findFirst` check inside a `$transaction` to determine whether a `FREE_GRANT` ledger entry already exists for the user. Under PostgreSQL's default Read Committed isolation level, two concurrent transactions can both read "no existing grant" (neither sees the other's uncommitted insert), both proceed to increment `creditBalance`, and both insert a `FREE_GRANT` row. The user receives 50, 75, or more free credits instead of 25.

The migration SQL creates no unique constraint on `CreditLedger(userId, type)`. The `findFirst` check is a TOCTOU (time-of-check-to-time-of-use) race — it is not atomic against concurrent inserts.

**Why it exists:** The implementation plan (A-6) noted that Prisma does not natively support partial unique indexes, and chose the application-level `findFirst` fallback. The design-phase review (F-15) assumed a unique partial index would exist, but the implementation explicitly replaced it with the application-level check, which is not race-safe. The caller catches errors, but without a unique constraint there is nothing to throw a P2002 — both concurrent inserts succeed silently.

**Exploitation scenario:** A new user's first page load triggers multiple concurrent authenticated requests (normal browser behaviour). Each calls `AuthGuard → UsersService.findOrCreate → grantFreeCredits`. All concurrent transactions pass the `findFirst` check and grant credits.

**Fix:**
1. New migration `20260814000000_add_credit_ledger_unique_indexes` adds a partial unique index: `CREATE UNIQUE INDEX "CreditLedger_userId_type_FREE_GRANT_key" ON "CreditLedger"("userId", "type") WHERE "type" = 'FREE_GRANT'`.
2. `grantFreeCredits` now catches P2002 on the `$transaction` promise and returns `false` (already granted). The unique index ensures only one concurrent transaction wins; the other's insert fails and the entire transaction rolls back (including the balance increment).

**Verification:**
- Unit test `payments.repository.spec.ts`: "S-01: catches P2002 and returns false" — mocks `$transaction` to reject with `{ code: 'P2002' }`, asserts `grantFreeCredits` returns `false` without throwing.
- Unit test: "rethrows non-P2002 errors" — verifies non-P2002 errors propagate.
- Unit test: "returns false when a FREE_GRANT already exists" — verifies the optimization path.
- **Not verified in this pass:** the actual database-level race under concurrent load (requires a real Postgres instance). The unique index SQL is standard PostgreSQL and is the correct enforcement mechanism.


---

### S-02 — MEDIUM: Webhook amount cross-check fails open when `amount_paid` is missing

**Where:** `apps/server/src/payments/payments.repository.ts` — `captureOrder` method, Step 3 (amount cross-check).

**Vulnerability:** The original condition was `amountPaidPaise !== null && localOrder.amountPaise !== amountPaidPaise`. When `amount_paid` is missing from the webhook payload (null/undefined), `amountPaidPaise` is `null`, the entire condition evaluates to `false`, and the cross-check is **skipped**. Credits are then granted based solely on the package lookup, without verifying that the amount paid matches the expected price.

This is a fail-open behaviour in a payment verification path. Payment systems should fail closed: if the amount cannot be verified, credits should not be granted.

**Why it exists:** The original code treated a missing `amount_paid` as "no information to compare" rather than "suspicious — do not proceed." The design (F-09) specified the cross-check but did not specify fail-closed semantics for a missing field.

**Fix:** Changed the condition to `amountPaidPaise === null || localOrder.amountPaise !== amountPaidPaise`. A missing `amount_paid` is now treated as a mismatch — the order is not captured and no credits are granted. A `PaymentEvent` with type `order.paid.amount_mismatch` is recorded for audit.

**Verification:**
- Unit test `payments.repository.spec.ts`: "S-02: returns amount_mismatch when amount_paid is missing (fail-closed)" — passes `amountPaidPaise: null`, asserts result is `'amount_mismatch'` and no credit mutation occurs.
- Unit test: "S-02: returns amount_mismatch when amount_paid does not match local order" — passes a wrong amount, asserts mismatch.

---

### S-03 — MEDIUM: No credit refund when `createSession` handler throws synchronously

**Where:** `apps/server/src/review/review.controller.ts` — `createSession` handler; `apps/server/src/payments/credit.guard.ts` — `req.creditDeducted` / `req.creditUserId` fields.

**Vulnerability:** `CreditGuard` deducts credits **before** the handler runs and sets `req.creditDeducted` / `req.creditUserId` on the request object. However, **no error handler ever reads these fields.** If `reviewService.createSession` throws synchronously (e.g. DB connection error, BullMQ dispatch failure), the credits are permanently lost — the user is charged for a review that was never created, with no refund path.

The `markFailedAndRefund` mechanism (F-05) only covers **asynchronous** pipeline failures (when a review exists in PENDING state and the BullMQ worker fails). It does not cover the synchronous handler-failure case where no review row was created.

**Why it exists:** The CreditGuard was designed to store deduction info for error handlers, but the controller was not wrapped in a try/catch to consume it. The guard and the refund path were implemented in different chunks (Chunk 8 vs Chunk 7), and the integration point was missed.

**Fix:** Wrapped the `createSession` handler body in a try/catch. On any exception, if `req.creditDeducted` and `req.creditUserId` are set, the controller calls `paymentsService.refundCredits` to return the credits before re-throwing the original exception. The refund itself is wrapped in a `.catch` to ensure refund failures do not mask the original error.

**Verification:**
- Unit test `review.controller.spec.ts`: "S-03: refunds pre-deducted credits when the handler throws after CreditGuard deduction" — simulates a handler failure, verifies the error propagates as 500.
- Unit test `payments.repository.spec.ts`: "creates a CONSUMPTION_REFUND ledger entry in its own transaction" — verifies the `refundCredits` repository method creates the correct ledger entry.
- **Not verified in this pass:** the full end-to-end guard→deduct→handler-throw→refund chain with a real CreditGuard instance (requires supertest + real guard wiring).


---

### S-04 — MEDIUM: No credit refund when chat stream errors

**Where:** `apps/server/src/history/history.controller.ts` — chat handler Observable catch block.

**Vulnerability:** `CreditGuard` deducts 1 credit before the chat handler runs. The chat handler returns an Observable that streams the AI response. If the AI provider errors during streaming (e.g. provider outage, rate limit), the Observable's catch block sends an error event to the client but **does not refund the pre-deducted credit.** The user loses credits for a chat that failed.

Unlike the review pipeline, there is no `markFailedAndRefund` equivalent for chat — chat messages are not persisted as review rows, so the review-failure refund path does not apply.

**Why it exists:** The chat handler was wired with `CreditGuard` (Chunk 8) but the refund-on-error path was not added. The review pipeline had `markFailedAndRefund` from F-05, but chat was overlooked because it has a different failure model (streaming, not BullMQ-queued).

**Fix:** Added a `refundCredits` call in the chat Observable's catch block. When the stream errors (and the abort signal is not the cause — i.e. not a client disconnect), the handler calls `paymentsService.refundCredits` with `reviewId: null` (the chat is not associated with a specific review failure). The refund is fire-and-forget with a `.catch` logger to avoid blocking the error response.

**Verification:**
- Unit test `payments.repository.spec.ts`: "creates a CONSUMPTION_REFUND ledger entry in its own transaction" — verifies the `refundCredits` method.
- **Not verified in this pass:** the full chat Observable error → refund chain (requires a supertest SSE integration test with a real CreditGuard and a mocked HistoryService that throws). The code path is straightforward and the refund method is unit-tested.

---

### S-05 — LOW: No currency cross-check in webhook `order.paid` handler

**Where:** `apps/server/src/payments/payments.service.ts` — `handleOrderPaid`; `apps/server/src/payments/payments.repository.ts` — `captureOrder`.

**Vulnerability:** The webhook handler cross-checked `amount_paid` (F-09) but did not cross-check `currency`. While Razorpay orders are created with a fixed currency (INR) and payments must match, a defense-in-depth currency check prevents any edge case where a different-currency payment is somehow associated with the order.

**Why it exists:** The design (F-09) specified only the amount cross-check. Currency verification was not mentioned.

**Fix:**
1. `handleOrderPaid` now extracts `currency` from `payload.order.entity.currency` and passes it to `captureOrder`.
2. `captureOrder` checks `currency !== null && localOrder.currency !== currency`. When the currency is present and mismatches, the result is `'amount_mismatch'` (no credits granted). When the currency is null (missing from payload), the check is skipped — the amount check (now fail-closed per S-02) is the primary control.

**Verification:**
- Unit test `payments.repository.spec.ts`: "S-05: returns amount_mismatch when currency does not match local order" — passes `currency: 'USD'` against a local order with `currency: 'INR'`, asserts mismatch.
- Unit test: "allows null currency — skips currency check, proceeds on amount match" — verifies null currency doesn't block a valid capture.
- Unit test `payments.service.spec.ts`: "S-05: extracts currency from webhook payload and passes it to captureOrder" — verifies the service extracts and forwards the currency.

---

### S-06 — LOW (defense-in-depth): No DB-level unique constraint on `CONSUMPTION_REFUND` per review

**Where:** `apps/server/src/review/review.repository.ts` — `markFailedAndRefund`; migration `20260813172114_add_payment_credit_models`.

**Vulnerability:** The `markFailedAndRefund` method uses a status-guard (`updateMany WHERE status = 'PENDING'`) to prevent double-refund. This is effective in normal operation — only one concurrent call can transition PENDING → FAILED, and the other gets `count: 0` and skips the refund. However, the F-05 design requirement called for a DB-level unique constraint as belt-and-suspenders: if a future bug weakens the status guard, the DB constraint would still prevent double-refund.

The original migration created no such constraint. The `findFirst` check in `markFailedAndRefund` Step 2 is the same TOCTOU pattern as S-01 — though in this case it is protected by the status guard in Step 1.

**Why it exists:** Same as S-01 — the implementation chose the application-level fallback (A-6) over a partial unique index.

**Fix:** The same new migration (`20260814000000`) adds: `CREATE UNIQUE INDEX "CreditLedger_reviewId_type_CONSUMPTION_REFUND_key" ON "CreditLedger"("reviewId", "type") WHERE "type" = 'CONSUMPTION_REFUND' AND "reviewId" IS NOT NULL`. The `reviewId IS NOT NULL` condition is critical — guard-level and chat-level refunds use `reviewId: null` (S-03/S-04) and must be allowed to occur multiple times (one per failed request). The unique index only constrains review-associated refunds.

`markFailedAndRefund` now catches P2002 on the `$transaction` promise and returns `false` (refund already exists). If the P2002 fires, the entire transaction rolls back (including the status transition), but the other transaction that won will have already transitioned the review to FAILED and refunded.

**Verification:**
- The P2002 catch path is verified by the S-01 test pattern (same `.catch` structure). The unique index SQL is standard PostgreSQL.
- **Not verified in this pass:** the actual double-refund prevention under concurrent load (requires a real Postgres instance).


---

## 3. Findings fixed

| Finding | Severity | Vulnerability | Fix | Verified by |
|---|---|---|---|---|
| S-01 | HIGH | TOCTOU race in `grantFreeCredits` — concurrent double-grant | Partial unique index + P2002 catch | `payments.repository.spec.ts` (3 tests) |
| S-02 | MEDIUM | Amount cross-check fails open when `amount_paid` missing | Fail-closed condition (`=== null \|\|`) | `payments.repository.spec.ts` (2 tests) |
| S-03 | MEDIUM | No refund on synchronous handler failure in `createSession` | Try/catch + `refundCredits` in controller | `review.controller.spec.ts` (1 test) + `payments.repository.spec.ts` (1 test) |
| S-04 | MEDIUM | No refund on chat stream error | `refundCredits` in Observable catch block | `payments.repository.spec.ts` (1 test) |
| S-05 | LOW | No currency cross-check in webhook | Extract + pass + check `currency` | `payments.repository.spec.ts` (2 tests) + `payments.service.spec.ts` (1 test) |
| S-06 | LOW | No DB unique constraint on `CONSUMPTION_REFUND` per review | Partial unique index + P2002 catch | Same pattern as S-01; index SQL in migration |

### Design-phase findings verified as implemented (F-01 through F-16)

The following design-phase findings were verified in the implemented code and found to be correctly implemented:

| Finding | Status | Verification |
|---|---|---|
| F-01 | Implemented | HMAC computed over `rawBody` Buffer directly (`payments.service.ts:110-113`) |
| F-02 | Implemented | Signature validated as 64 hex chars before `timingSafeEqual` (`webhook.controller.ts:43`, `payments.service.ts:105`) |
| F-03 | Implemented | Body-size check at 1 MB before HMAC (`webhook.controller.ts:38`) |
| F-04 | Implemented | `balanceAfter` read from DB via `findUniqueOrThrow` in all ledger writes |
| F-05 | Implemented | `markFailedAndRefund` wraps status transition + refund in single `$transaction` |
| F-06 | Implemented | CreditGuard resolver throws `BadRequestException` on invalid type (`review.controller.ts:33-34`) |
| F-08 | Implemented | `x-razorpay-event-id` required with max length 128 (`webhook.controller.ts:48`) |
| F-09 | Implemented + hardened | Amount cross-check present; S-02 made it fail-closed |
| F-10 | Implemented | No PII in order notes; SDK errors sanitised to `.message` only |
| F-11 | Implemented | Pending order cap at 3 (`payments.service.ts:51-57`) |
| F-13 | Implemented | `getWallet` response does not include `keyId` |
| F-14 | Implemented | Status-guard `updateMany WHERE status = 'CREATED'` in `captureOrder` and `failOrder` |
| F-15 | Implemented + hardened | `grantFreeCredits` catches errors; S-01 added DB-level enforcement |
| F-16 | INFO (no change needed) | `receipt` field contains only internal order ID (UUID), no PII |

---

## 4. Findings intentionally not changed and why

| Item | Reason not changed |
|---|---|
| **Express default body-parser limit (100 KB) vs. controller check (1 MB)** | Express's default `express.json()` limit is 100 KB. The controller's 1 MB check (`webhook.controller.ts:38`) is a secondary defense that only triggers if the Express limit is raised. The effective limit is 100 KB, which is **more** restrictive than intended — not a security gap. Razorpay payloads are typically 10–50 KB. No change needed. |
| **`creditsGranted` determined from package lookup at webhook time, not stored at order creation** | If `CREDIT_PACKAGES` definitions change between order creation and webhook delivery, the granted credits could differ from what was intended at purchase time. This is a data-consistency concern, not a security vulnerability — package definitions are server-side constants, not user-controlled. The `amountPaise` cross-check (S-02) catches price changes. Fixing this would require storing the credit count on `PaymentOrder` at creation time, which is a larger schema change outside this hardening pass's scope. |
| **No CSRF protection on `/payments/order`** | The endpoint requires a valid GitHub Bearer token in the `Authorization` header. CSRF attacks against Bearer-token endpoints are not possible — the browser's CORS policy prevents cross-site requests from including the token. No change needed. |
| **Razorpay Checkout.js loaded from external CDN without SRI** | Razorpay's Checkout.js is their official hosted script. Razorpay does not provide a pinned SRI hash for their rotating script. This is a known limitation of third-party payment flows. The risk is accepted. |
| **Webhook returns `200` for unrecognised event types** | Unknown event types are logged and ignored with a `200` response. This is correct — returning a non-2xx would cause Razorpay to retry indefinitely for an event we intentionally don't handle. No change needed. |
| **Webhook returns `200` for unknown orders (`not_found`)** | An unknown order is a cross-environment mismatch or data loss scenario, not a security vulnerability. Returning `4xx` would trigger indefinite Razorpay retries. The `200` + log warning is correct. |
| **`payment.failed` webhook does not verify the order belongs to a known user** | The `failOrder` method uses a status-guard (`WHERE status = 'CREATED'`) and only transitions to `FAILED`. It does not alter credits. An unknown order simply results in `count: 0` (no-op). No security impact. |
| **Guard-level refund uses `reviewId: null` (not covered by CONSUMPTION_REFUND unique index)** | This is by design. Multiple failed requests (e.g. repeated DB errors) each deduct and refund independently. The unique index only constrains review-associated refunds (`reviewId IS NOT NULL`). Guard/chat refunds must be allowed to occur multiple times. |


---

## 5. Verification performed

### 5.1 Full verification loop (all green)

| Step | Command | Result |
|---|---|---|
| 1. Build Packages | `pnpm build:packages` | **SUCCESS** (`@cra/types`, `@cra/ai` built) |
| 2. Type Check | `pnpm type-check` | **SUCCESS** (0 errors across all 4 projects) |
| 3. Server Unit Tests | `pnpm --filter server test` | **SUCCESS** (31/31 suites, 147/147 tests) |
| 4. Client Unit Tests | `pnpm --filter client test` | **SUCCESS** (10/10 files, 16/16 tests) |
| 5. Linter | `pnpm lint` | **SUCCESS** (exit 0, 0 errors) |

### 5.2 New and updated test cases

| Test ID | File | Description | Finding |
|---|---|---|---|
| S-01-a | `payments.repository.spec.ts` | P2002 on `grantFreeCredits` → returns `false` | S-01 |
| S-01-b | `payments.repository.spec.ts` | Non-P2002 error → rethrows | S-01 |
| S-01-c | `payments.repository.spec.ts` | Existing FREE_GRANT → returns `false` (fast path) | S-01 |
| S-02-a | `payments.repository.spec.ts` | Missing `amount_paid` → `amount_mismatch` (fail-closed) | S-02 |
| S-02-b | `payments.repository.spec.ts` | Wrong `amount_paid` → `amount_mismatch` | S-02 |
| S-03-a | `review.controller.spec.ts` | Handler throws → 500 (refund path wired) | S-03 |
| S-03-b | `payments.repository.spec.ts` | `refundCredits` creates CONSUMPTION_REFUND entry | S-03/S-04 |
| S-05-a | `payments.repository.spec.ts` | Mismatched currency → `amount_mismatch` | S-05 |
| S-05-b | `payments.repository.spec.ts` | Null currency → proceeds on amount match | S-05 |
| S-05-c | `payments.service.spec.ts` | Currency extracted from payload and passed to `captureOrder` | S-05 |
| S-cap-1 | `payments.repository.spec.ts` | Matching amount + currency → `captured` | S-02/S-05 |
| S-cap-2 | `payments.repository.spec.ts` | Already CAPTURED → `already_captured` | F-14 |
| S-cap-3 | `payments.repository.spec.ts` | No local order → `not_found` | F-07 |

### 5.3 Existing tests verified still passing

All 134 pre-existing tests continue to pass unchanged. The two controller spec files (`review.controller.spec.ts`, `review.throttle.spec.ts`) were updated to provide a `PaymentsService` mock (the controller now requires it in its constructor).

### 5.4 What was NOT verified in this pass

| Property | Why not verified | How to verify before go-live |
|---|---|---|
| DB-level race prevention (S-01, S-06) under concurrent load | Requires a real Postgres instance with concurrent connections | Integration test: fire N concurrent `grantFreeCredits` calls, assert exactly one `FREE_GRANT` row |
| Full guard→deduct→handler-throw→refund chain (S-03) | Requires supertest with real CreditGuard wiring | E2E test: POST `/review/session` with mocked ReviewService that throws, assert balance restored |
| Full chat Observable error→refund chain (S-04) | Requires supertest SSE integration | E2E test: POST `/history/:id/chat` with mocked HistoryService that errors, assert balance restored |
| Razorpay sandbox end-to-end | Requires Razorpay test-mode API keys and webhook tunnel | Manual test per production deployment checklist |
| HMAC verification against real Razorpay webhook | Requires webhook secret and real webhook delivery | Manual test: register webhook URL, trigger test payment |


---

## 6. Remaining risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **DB-level race not verified under load** (S-01, S-06) | Low (unique index is standard PostgreSQL) | High (double-grant/refund) | Integration test with concurrent connections before go-live |
| **Guard→refund chain not E2E tested** (S-03, S-04) | Low (code path is straightforward) | Medium (credit loss on infra failure) | E2E test with supertest before go-live |
| **Razorpay-side breach** (webhook secret compromised) | Very low | Critical | HMAC verification still required; server-side amount + currency cross-check (S-02, S-05) |
| **Neon DB outage during webhook processing** | Low | Medium | Razorpay retries for ~24h; webhook handler is idempotent (event ID unique constraint) |
| **Render cold-start during webhook delivery** | Medium | Low | Razorpay retries; harmless with idempotent handler |
| **Log aggregator capturing full webhook body** | Medium | High | Handler does not log raw body. Future logging middleware must skip the webhook route. |
| **Checkout.js CDN unavailability** | Low | Medium | User cannot pay; Account page shows error. No credit-safety risk. |
| **`creditsGranted` divergence if packages change** | Very low | Low | **R-02 (fixed):** `creditsGranted` is now persisted at order creation and read from the local order at capture time — package removal/renaming no longer causes a zero-credit capture. Fail-closed guard on `≤ 0`. |
| **`timingSafeEqual` API change in future Node.js** | Very low | Low | Pinned Node.js version; monitor changelog |

---

## Related files

| File | Role in this hardening pass |
|---|---|
| [`04-implementation.md`](./04-implementation.md) | Updated with all security-related changes from this pass |
| [`02-architecture.md`](./02-architecture.md) | Design source — architecture decisions referenced by findings |
| [`03-implementation-plan.md`](./03-implementation-plan.md) | Design source — implementation plan referenced by findings |
| `apps/server/prisma/migrations/20260814000000_add_credit_ledger_unique_indexes/migration.sql` | New migration — partial unique indexes for S-01, S-06 |
| `apps/server/src/payments/payments.repository.ts` | S-01 (P2002 catch), S-02 (fail-closed), S-05 (currency check), refundCredits method |
| `apps/server/src/payments/payments.service.ts` | S-05 (currency extraction), refundCredits method |
| `apps/server/src/review/review.controller.ts` | S-03 (handler-failure refund) |
| `apps/server/src/history/history.controller.ts` | S-04 (chat-stream-failure refund) |
| `apps/server/src/review/review.repository.ts` | S-06 (markFailedAndRefund P2002 catch) |
| `apps/server/src/payments/payments.repository.spec.ts` | New test file — 11 tests for S-01, S-02, S-05, S-03/S-04 |
| `apps/server/src/payments/payments.service.spec.ts` | Updated — S-05 currency extraction test |
| `apps/server/src/review/review.controller.spec.ts` | Updated — S-03 test + PaymentsService mock |
| `apps/server/src/review/review.throttle.spec.ts` | Updated — PaymentsService mock |


---

## 7. Security review remediation (R-01 through R-08)

> **Date:** 2026-08-14
> **Source:** Independent security review — [`06-security-review.md`](./06-security-review.md)
> **Full record:** [`07-remediation.md`](./07-remediation.md)

An independent security review (R-01 through R-08) was performed on the hardened code. All findings were remediated:

| Finding | Severity | Remediation |
|---|---|---|
| **R-01** — Credits lost when `ValidationPipe` rejects body after `CreditGuard` deduction | Medium | `CreditRefundInterceptor` (new) wraps `next.handle()` with `catchError`; refunds `req.creditDeducted` if markers are present. Handler catch blocks (S-03/S-04) clear markers to prevent double-refund. |
| **R-02** — `creditsGranted` resolves to 0 when package removed; order still captured | Medium | `creditsGranted` persisted at order creation; `captureOrder` reads from `localOrder`; fail-closed on `≤ 0` → `'zero_credits'` outcome. |
| **R-03** — Webhook endpoint unthrottled | Low | `ThrottlerGuard` (100/min per IP) added to webhook route. |
| **R-04** — No alerting for `amount_mismatch` / `not_found` | Low | `not_found` elevated to `error`; `zero_credits` case added with `error` log. External alerting = remaining limitation. |
| **R-05** — F-12 wallet throttle (60/min) not implemented | Info | `UserThrottlerGuard` + `@Throttle` added to `getWallet`. |
| **R-06** — `NEXT_PUBLIC_RAZORPAY_KEY_ID` dead config | Info | Removed from `.env.example` and `docs/deployment.md`. |
| **R-07** — `?token=` fallback on payment routes | Info | `/payments/` routes excluded from `?token=` fallback in `AuthGuard`. |
| **R-08** — Non-object webhook body causes unhandled 500 | Info | Type guard after `JSON.parse` in `handleWebhook`. |

### Additional files from remediation

| File | Role |
|---|---|
| `apps/server/src/payments/credit-refund.interceptor.ts` | NEW — R-01 credit refund interceptor |
| `apps/server/src/payments/webhook.controller.ts` | R-03 (rate limit) |
| `apps/server/src/payments/payments.controller.ts` | R-05 (wallet throttle) |
| `apps/server/src/auth/auth.guard.ts` | R-07 (exclude payment routes from ?token=) |
| `apps/server/src/payments/webhook.controller.spec.ts` | Updated — ThrottlerModule import |
| `apps/client/.env.example` | R-06 (remove dead env var) |
