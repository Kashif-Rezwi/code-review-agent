# Razorpay & Credit Subsystem — Final Production Readiness Audit

> **Document Version:** 1.0.0  
> **Audit Date:** 2026-08-15  
> **Target System:** Code Review Agent (`apps/server`, `apps/client`, `packages/types`, `packages/ai`)  
> **Audit Type:** Final Production-Readiness Verification & Target Architecture Compliance Audit  
> **Auditor Stance:** Independent, adversarial, evidence-based. No assumptions of correctness from previous designs or passing tests.  
> **Production Readiness Verdict:** **⚠️ Conditionally Production Ready**

---

## 1. Executive Summary

This document presents the **final production-readiness audit** of the Razorpay payment integration, prepaid credit wallet, and consumption lifecycle in the **Code Review Agent** monorepo.

The system was audited following the complete implementation of the target architecture designed in [`docs/architecture/razorpay-credit-architecture.md`](file:///Users/kashifrezwi/Developer/code-review-agent/docs/architecture/razorpay-credit-architecture.md) and [`docs/architecture/razorpay-credit-implementation-plan.md`](file:///Users/kashifrezwi/Developer/code-review-agent/docs/architecture/razorpay-credit-implementation-plan.md).

### 1.1 Summary of Architectural Improvements Verified

1. **Elimination of Fragile Guard Pre-Deduction:** The obsolete `CreditGuard`, `CreditRefundInterceptor`, and `@CreditCost` decorators have been completely deleted. Credit consumption for reviews is executed **atomically inside `ReviewRepository.createSession`'s interactive database transaction**. DTO validation via NestJS `ValidationPipe` executes before any database connection is acquired, completely eliminating validation-failure refund churn.
2. **Zero-Traceability Consumption Gap Resolved (RZC-003):** Every review session consumption ledger row is created with `reviewId = review.id` populated at millisecond zero within the creation `$transaction`. Follow-up chat consumptions record `reviewId` immediately upon deduction.
3. **Restored Domain Encapsulation (RZC-001, RZC-002):** `ReviewRepository` no longer mutates user balances directly. Failure refunds (`markFailedAndRefund`) and user cancellations (`markCancelledAndRefund`) delegate financial mutations to `PaymentsRepository.refundCreditsInTx` within the review status-update transaction.
4. **Decoupled Gateway Abstraction (RZC-013):** `PaymentsService` no longer directly instantiates the concrete Razorpay SDK. All external communication is mediated by `PaymentGateway` and `RazorpayGatewayAdapter`, isolating SDK errors and HMAC comparisons.
5. **Decoupled Module Graph (RZC-008):** `AuthModule` is annotated with `@Global()`. `forwardRef(() => AuthModule)` has been completely removed across the monorepo, establishing a strict acyclic dependency hierarchy.
6. **Automated Order Reaping & Drift Reconciliation (RZC-009, RZC-010):** A scheduled background sweeper reaps abandoned `CREATED` orders every 15 minutes. An authoritative balance reconciliation query (`checkBalanceDrift` and `reconcileUserBalance`) detects and repairs denormalized `User.creditBalance` drifts against `SUM(CreditLedger.amount)`.
7. **Operational Hardening (RZC-012, RZC-014):** Reverse-proxy IP forwarding (`app.set('trust proxy', 1)`) is enabled, and structured operational tags (`[RZP_ORDER_CREATED]`, `[RZP_WEBHOOK_CAPTURED]`, `[RZP_MISMATCH]`, `[R-02]`, `[F-09]`) are emitted for all financial state changes and anomalies.

### 1.2 Residual Deficiencies & Open Findings

Despite the major architectural success on the server and database tiers, this audit identified **3 residual findings**:

- **PRD-001 (Medium Severity — Incomplete Frontend Migration):** `WalletProvider` was created in `context/wallet-context.tsx` and mounted in `RootLayout`, but `apps/client/lib/use-wallet.ts` was not refactored to delegate to `useWalletContext()`. Components (`AppHeader`, `ReviewPageClient`, `AccountPage`) continue to instantiate separate, unshared hook instances, resulting in desynchronized UI credit badges and redundant network requests.
- **PRD-002 (Low Severity — Missing Migration File for `CreditLedger` Index):** `schema.prisma` defines `@@index([reviewId])` on `CreditLedger`, but this index exists only in the Prisma schema and lacks a committed SQL migration file in `prisma/migrations/`.
- **PRD-003 (Low Severity — Chat Deduction Precedes Ownership Check):** In `POST /history/:id/chat`, credits are deducted before verifying that the review ID exists and belongs to the authenticated user. Invalid review IDs trigger a deduction followed immediately by a catch-block refund.

---

## 2. Reconstructed Final Architecture

### 2.1 System Topology & Runtime Flow

```
User (Browser)
     │
     ├── 1. POST /payments/order ──────────┐
     │                                     ▼
     │                          ┌───────────────────────────┐
     │                          │    PaymentsController     │
     │                          │    (UserThrottlerGuard)   │
     │                          └─────────────┬─────────────┘
     │                                        │
     │                                        ▼
     │                          ┌───────────────────────────┐
     │                          │      PaymentsService      │
     │                          └─────────────┬─────────────┘
     │                                        │
     │                           createOrder  │ verifyWebhookSignature
     │                                        ▼
     │                          ┌───────────────────────────┐
     │                          │  RazorpayGatewayAdapter   │
     │                          └─────────────┬─────────────┘
     │                                        │
     │                                        ▼
     │                          ┌───────────────────────────┐
     │                          │     Razorpay API / SDK    │
     │                          └─────────────┬─────────────┘
     │                                        │
     │                                        │ Webhook POST /payments/webhook
     │                                        ▼ (HMAC-SHA256 Signed)
     │                          ┌───────────────────────────┐
     │                          │     WebhookController     │
     │                          │   (ThrottlerGuard / IP)   │
     │                          └─────────────┬─────────────┘
     │                                        │
     │                                        ▼
     │                          ┌───────────────────────────┐
     │                          │    PaymentsRepository     │
     │                          │  (Prisma Interactive Tx)  │
     │                          └─────────────┬─────────────┘
     │                                        │
     │                                        ▼
     │                          ┌───────────────────────────┐
     │                          │    PostgreSQL Database    │
     │                          │ (User, Orders, Ledger,    │
     │                          │  Events, Reviews, RAG)    │
     │                          └───────────────────────────┘
     │                                        ▲
     │                                        │
     ├── 2. POST /review/session ─────────────┤
     │      (ValidationPipe -> ReviewService ─┘
     │       -> Atomic In-Tx Deduction)
     │
     └── 3. POST /history/:id/chat ───────────┘
            (ValidationPipe -> HistoryController
             -> Deduct 1 credit -> Stream -> Refund if 0 chunks)
```

### 2.2 Component Inventory & Ownership Matrix

| Component | Layer / Package | Primary Responsibility | Mutation Authority | Upstream Callers | Downstream Dependencies |
|---|---|---|---|---|---|
| `PaymentsController` | `server/payments` | Authenticated order creation & wallet summary queries | None (Delegates) | Frontend `api.ts` | `PaymentsService`, `AuthGuard`, `UserThrottlerGuard` |
| `WebhookController` | `server/payments` | Unauthenticated Razorpay webhook entry point | None (Delegates) | Razorpay Webhook Dispatcher | `PaymentsService`, `ThrottlerGuard` |
| `PaymentGateway` | `server/payments/gateway` | Gateway abstraction contract | External Gateway | `PaymentsService` | `RazorpayGatewayAdapter` |
| `RazorpayGatewayAdapter`| `server/payments/gateway` | Encapsulates Razorpay SDK, order creation, timing-safe HMAC | None | `PaymentsService` | Razorpay SDK, `ConfigService` |
| `PaymentsService` | `server/payments` | Coordinates payment lifecycle, webhook routing, wallet orchestration, background order sweeper | Business Rules | `PaymentsController`, `WebhookController`, `HistoryController`, `UsersService` | `PaymentsRepository`, `PaymentGateway`, `ConfigService` |
| `PaymentsRepository` | `server/payments` | Authoritative database mutations for orders, events, ledger, drift checks | Authoritative for Financial Tables | `PaymentsService`, `ReviewRepository` | `PrismaService` (`User`, `PaymentOrder`, `PaymentEvent`, `CreditLedger`) |
| `ReviewController` | `server/review` | HTTP entry point for code/PR reviews and cancellations | None (Delegates) | Frontend `api.ts` | `ReviewService`, `HistoryService`, `AuthGuard` |
| `ReviewService` | `server/review` | Orchestrates review pipeline, dispatching, and queue management | Business Rules | `ReviewController`, `ReviewProcessor` | `ReviewRepository`, `QueueService`, `RedisService`, `AiService`, `RagService`, `GithubService` |
| `ReviewRepository` | `server/review` | Review persistence and atomic in-transaction session deduction | Authoritative for `Review`, `ReviewDispatch` | `ReviewService` | `PrismaService`, `PaymentsRepository.refundCreditsInTx` |
| `HistoryController` | `server/history` | Review history retrieval and SSE chat streaming | None (Delegates) | Frontend `api.ts` | `HistoryService`, `PaymentsService`, `AuthGuard` |
| `HistoryService` | `server/history` | Chat streaming generator and history queries | Chat History | `HistoryController`, `ReviewController` | `HistoryRepository`, `AiService` |
| `WalletProvider` | `client/context` | React Context for shared client-side wallet state | Client State | `RootLayout` | `paymentsService` (`lib/api.ts`) |
| `useWallet` | `client/lib` | Standalone hook for wallet fetching and polling | Client State | `AppHeader`, `ReviewPageClient`, `AccountPage` | `paymentsService` (`lib/api.ts`) |

---

## 3. Previous Finding Resolution Matrix

| Previous Finding ID | Previous Audit Finding Summary | Intended Target Resolution | Actual Implementation Status | Fully Resolved? | Regression? | Audit Notes |
|---|---|---|---|---|---|---|
| **RZC-001** | `ReviewRepository` directly mutated `User.creditBalance` and `CreditLedger` on failure/cancel | Delegate refunds to `PaymentsRepository.refundCreditsInTx` | `ReviewRepository.markFailedAndRefund` (L110) and `markCancelledAndRefund` (L148) invoke `paymentsRepository.refundCreditsInTx(tx, ...)`. | ✅ Yes | None | Domain boundary between review and billing restored. |
| **RZC-002** | `refundCreditsInTx` was dead code in `PaymentsService` and `PaymentsRepository` | Activate `refundCreditsInTx` as standard transactional refund pipeline | `refundCreditsInTx` is actively invoked by `ReviewRepository` and covered by tests. | ✅ Yes | None | Dead code removed; pipeline fully utilized. |
| **RZC-003** | `CONSUMPTION` ledger rows persisted with `reviewId = null` | Link `reviewId` at creation in single `$transaction` | `ReviewRepository.createSession` (L58) writes `reviewId: review.id` in the same transaction as Review creation. `HistoryController.chat` (L65) passes `reviewId: id`. | ✅ Yes | None | 100% of consumption entries now have entity linkage. |
| **RZC-004** | Fragile 3-layer refund architecture with mutable `req.creditDeducted` markers | Eliminate pre-handler refund layers; rely on DB transaction rollback | `CreditGuard` and `CreditRefundInterceptor` deleted. Only background worker failures and cancellations refund. | ✅ Yes | None | Massive simplification of error-handling paths. |
| **RZC-005** | Guard pre-deduction preceded DTO validation, causing validation churn | NestJS `ValidationPipe` validates DTOs before any DB transaction | `CreateSessionDto` validated prior to `ReviewService.createSession`. Invalid payloads 400 with 0 DB writes. | ✅ Yes | None | Zero financial writes on malformed user requests. |
| **RZC-006** | Client wallet state fragmented across independent hook instances | Shared `WalletProvider` React Context at root | `WalletProvider` created & mounted in `layout.tsx`, but `use-wallet.ts` was not wired to it. Components still instantiate independent hooks. | ⚠️ Partially | None | Recorded as finding **PRD-001**. |
| **RZC-007** | Brittle client polling termination (`balance > initialBalance`) | Polling detects target `orderId` in ledger entries | `wallet-context.tsx` and `use-wallet.ts` inspect `data.ledger.some(e => e.orderId === targetOrderId)`. | ✅ Yes | None | Eliminates false-positive timeout loops on concurrent spend. |
| **RZC-008** | Circular module dependency `AuthModule <-> UsersModule <-> PaymentsModule` | Mark `AuthModule` as `@Global()`, remove `forwardRef` | `AuthModule` marked `@Global()`; `forwardRef` completely eliminated across the server. | ✅ Yes | None | Clean DAG module dependency structure. |
| **RZC-009** | Stale pending order expiration was lazy with no background sweeper | Background scheduled job to expire abandoned `CREATED` orders | `PaymentsService` schedules 15-minute periodic sweeper via `setInterval` + `unref()` + `onModuleDestroy`. | ✅ Yes | None | Database clean of abandoned pending orders. |
| **RZC-010** | Denormalized `User.creditBalance` lacked reconciliation routines | Implement `checkBalanceDrift` and `reconcileUserBalance` | Implemented in `PaymentsRepository` (L435, L459) with raw SQL drift query and aggregate ledger update. | ✅ Yes | None | Automated drift detection and repair capability online. |
| **RZC-011** | Full credit refund emitted after partial chat stream delivery | Only refund chat credit if error occurs before first token emitted | `HistoryController.chat` tracks `emittedChunkCount`; refunds only when `emittedChunkCount === 0`. | ✅ Yes | None | Partial streaming delivers value and is not refunded. |
| **RZC-012** | Absence of operational telemetry & alerting for payment anomalies | Structured logging tags for revenue-impacting events | Tags `[RZP_ORDER_CREATED]`, `[RZP_WEBHOOK_CAPTURED]`, `[RZP_MISMATCH]`, `[R-02]`, `[F-09]` emitted. | ✅ Yes | None | Logs are indexable and alertable in Datadog/CloudWatch. |
| **RZC-013** | Direct coupling to Razorpay SDK in `PaymentsService` | Extract `PaymentGateway` interface and adapter | `PaymentGateway` interface and `RazorpayGatewayAdapter` created; `PaymentsService` decoupled. | ✅ Yes | None | Easy mockability and multi-gateway extensibility. |
| **RZC-014** | Webhook controller IP throttler vulnerable behind reverse proxies | Enable `trust proxy` in NestJS bootstrap | `app.set('trust proxy', 1)` configured in `apps/server/src/main.ts`. | ✅ Yes | None | Accurate upstream IP rate limiting for webhooks. |

---

## 4. Razorpay Integration Final Audit

### 4.1 Order Creation & Parameters
- **Server-Side Authority:** Prices and packages are strictly sourced from `CREDIT_PACKAGES` in [`credit-cost.policy.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-cost.policy.ts). Client-submitted amounts or credits are never accepted.
- **Pending Order Limit (F-11):** `PaymentsService.createOrder` enforces `countPendingOrders(userId) < MAX_PENDING_ORDERS` (3), preventing malicious or accidental order flooding.
- **PII Omission (F-10):** `notes` passed to Razorpay API contain only `{ packageId }`. `userId` is omitted to prevent user PII leakage into external payment gateway logs.
- **Immutable Package Credits (R-02):** `creditsGranted` is persisted on `PaymentOrder` at order creation time (`PaymentOrder.creditsGranted = pkg.credits`). During webhook processing, `captureOrder` reads `creditsGranted` directly from the local record, guaranteeing that future package configuration changes cannot alter historical orders.

### 4.2 Webhook Ingestion & Cryptographic Security
- **Timing-Safe HMAC-SHA256:** `RazorpayGatewayAdapter.verifyWebhookSignature` uses `crypto.timingSafeEqual` over raw Buffer bytes (`req.rawBody`).
- **Signature Format Validation (F-02):** Validates `/^[0-9a-f]{64}$/` format before `Buffer.from(signatureHeader, 'hex')`, preventing `RangeError` exceptions on malformed header lengths.
- **Payload Size Enforcement (F-03):** `WebhookController` checks `rawBody.length <= WEBHOOK_MAX_BODY_BYTES` (1 MB) and throws `PayloadTooLargeException` before JSON parsing.
- **Event ID Bounds (F-08):** Requires `x-razorpay-event-id` header presence and length `<= 128`.

### 4.3 Fail-Closed Financial Validation
- **Amount Cross-Check (F-09, S-02):** `captureOrder` verifies `localOrder.amountPaise === amountPaidPaise`. If `amountPaidPaise` is missing or mismatched, capture aborts, records `order.paid.amount_mismatch`, and logs `[F-09]`.
- **Currency Cross-Check (S-05):** Verifies `localOrder.currency === currency`.
- **Zero-Credit Guard (R-02):** If `localOrder.creditsGranted <= 0`, capture aborts and records `order.paid.zero_credits`.
- **Environment Isolation (RZP-002):** If an `order.paid` webhook arrives for an unknown `razorpayOrderId` (e.g. from another test environment), `captureOrder` inserts a `PaymentEvent` with `razorpayOrderId = null` and returns `'not_found'` with HTTP 200, preventing foreign-key constraint crashes.

---

## 5. Credit Wallet & Consumption Subsystem Final Audit

### 5.1 Balance Representation & Mathematical Invariant
The wallet uses a **dual-write model**:
1. `User.creditBalance` (denormalized `Int`) for $O(1)$ fast lookups and atomic conditional decrements.
2. `CreditLedger` (append-only table) recording every balance mutation with `type`, `amount`, `balanceAfter`, `orderId`, and `reviewId`.

The mathematical invariant is enforced:
$$\text{User.creditBalance} \equiv \sum_{l \in \text{CreditLedger}(\text{userId})} l.\text{amount}$$

### 5.2 Consumption Lifecycle & Anti-Double-Spend
- **Atomic In-Transaction Consumption:** In `ReviewRepository.createSession`, credit deduction uses conditional SQL decrement:
  ```typescript
  const deducted = await tx.user.updateMany({
      where: { id: userId, creditBalance: { gte: cost } },
      data: { creditBalance: { decrement: cost } },
  })
  if (deducted.count === 0) {
      throw new HttpException(
          { statusCode: HttpStatus.PAYMENT_REQUIRED, message: 'Insufficient credits. Please top up your balance.' },
          HttpStatus.PAYMENT_REQUIRED,
      )
  }
  ```
- **Guaranteed Entity Linkage:** `CreditLedger.reviewId` is populated with `review.id` in the very same transaction.
- **Snapshot Accuracy:** `balanceAfter` is read directly from PostgreSQL via `tx.user.findUniqueOrThrow` within the transaction, never calculated in application memory.

### 5.3 Failure & Cancellation Refund Pipeline
- **Asynchronous Worker Failure:** When BullMQ fails or times out, `ReviewService.runForQueue` catches the error and invokes `ReviewRepository.markFailedAndRefund`. In a single `$transaction`:
  1. `Review.status` transitions `PENDING -> FAILED`.
  2. Calls `PaymentsRepository.refundCreditsInTx`, which checks for existing refunds, increments `creditBalance`, and writes a `CONSUMPTION_REFUND` ledger row.
- **User Cancellation:** When a user cancels a review in progress (`DELETE /review/:id`), `ReviewService.cancelReview` invokes `ReviewRepository.markCancelledAndRefund`. In a single `$transaction`:
  1. `Review.status` transitions `PENDING -> CANCELLED`.
  2. `ReviewDispatch.status` transitions `PENDING/PROCESSING -> CANCELLED`.
  3. Calls `PaymentsRepository.refundCreditsInTx` to restore credits.

---

## 6. Security & Adversarial Verification

| Attack Vector / Security Concern | Target Guarantee | Implementation Enforcement | Verified Status |
|---|---|---|---|
| **Client-Controlled Pricing / Credits** | Zero trust in client parameters | Server policy [`credit-cost.policy.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-cost.policy.ts) enforces all prices, packages, and costs. | ✅ Verified Secure |
| **Client Payment Verification Spoofing** | No client-side payment confirmation | Webhook-exclusive entitlement. No `POST /payments/verify` endpoint exists. | ✅ Verified Secure |
| **Timing Attacks on Webhooks** | Constant-time HMAC comparison | `crypto.timingSafeEqual` over raw buffer bytes in `RazorpayGatewayAdapter`. | ✅ Verified Secure |
| **Signature Format RangeErrors** | No crash on malformed signature header | Regex `/^[0-9a-f]{64}$/` format check in adapter before hex buffer decoding. | ✅ Verified Secure |
| **Webhook Payload Bomb / DOS** | Strict body size limit | `rawBody.length <= 1_048_576` checked before HMAC or JSON parsing. | ✅ Verified Secure |
| **Signup Free-Credit Double Spend** | Exactly one 25-credit gift per user | PostgreSQL partial unique index `CreditLedger_userId_type_FREE_GRANT_key` + P2002 error handling. | ✅ Verified Secure |
| **Review Refund Duplication** | At most one refund per failed review | `Review.status = 'PENDING'` transition guard + partial unique index `CreditLedger_reviewId_type_CONSUMPTION_REFUND_key`. | ✅ Verified Secure |
| **Negative Credit Balance Attack** | User balance cannot drop below 0 | Conditional decrement `WHERE creditBalance >= cost` in interactive transactions. | ✅ Verified Secure |
| **Cross-User Credit Consumption / IDOR** | Cannot spend another user's balance | `req.user.userId` extracted from authenticated GitHub session token by `AuthGuard`. | ✅ Verified Secure |
| **PII in External Gateway Logs** | No customer email/names in Razorpay | Only `{ packageId }` passed in Razorpay order `notes`. `userId` is omitted. | ✅ Verified Secure |

---

## 7. Idempotency & Concurrency Audit

### 7.1 Idempotency Mechanisms

| Operation | Idempotency Key | Deduplication Mechanism | Duplicate Behavior |
|---|---|---|---|
| **Webhook Ingestion** | `x-razorpay-event-id` | `PaymentEvent.razorpayEventId` unique constraint | Catches `P2002`, `P2028`, `P2034` -> returns HTTP 200 OK (no-op). |
| **Order Capture** | `razorpayOrderId` | `PaymentOrder.status in ['CREATED', 'FAILED', 'EXPIRED'] -> CAPTURED` | Second capture sees `count = 0` -> returns `'already_captured'`. |
| **Signup Free Grant** | `userId` + `'FREE_GRANT'` | Partial unique index on `CreditLedger(userId, type)` WHERE `type = 'FREE_GRANT'` | Second transaction fails unique index -> caught & ignored cleanly. |
| **Review Failure Refund** | `reviewId` + `'CONSUMPTION_REFUND'` | `Review.status = 'PENDING'` status guard + partial unique index on `CreditLedger(reviewId, type)` | Only active reviews refund; second attempt blocked by DB constraint. |
| **Review Cancellation Refund** | `reviewId` + `'CONSUMPTION_REFUND'` | `Review.status = 'PENDING'` status guard + partial unique index | Exactly-once refund. |

### 7.2 Concurrency Scenarios

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CONCURRENCY ANALYSIS RESULTS                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SCENARIO A: Two concurrent review creations with balance = 5 (cost = 5)                          │
│ - Both enter ReviewRepository.createSession.                                                     │
│ - Request 1 acquires PostgreSQL row lock on User row, decrements balance to 0, count = 1.        │
│ - Request 2 acquires row lock, checks WHERE creditBalance >= 5 -> evaluates to FALSE (count = 0).│
│ - Request 2 rolls back and returns HTTP 402 Payment Required.                                    │
│ - Result: Balance is 0; exactly one review is created. Anti-double-spend lock holds.              │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SCENARIO B: Webhook order.paid arrives twice in a 10ms burst                                     │
│ - Transaction 1 inserts PaymentEvent (razorpayEventId = 'evt_1') and captures order.             │
│ - Transaction 2 attempts to insert PaymentEvent with same razorpayEventId -> P2002 violation.     │
│ - Transaction 2 rolls back; service catches P2002 and returns 'duplicate' (HTTP 200 to Razorpay).│
│ - Result: Exactly 1 balance increment and 1 PURCHASE ledger entry.                               │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SCENARIO C: Late webhook delivery on an EXPIRED order                                            │
│ - Order was expired by the 15-minute background sweeper (status: EXPIRED).                       │
│ - Customer completed payment on Razorpay before checkout window closed; order.paid arrives.      │
│ - captureOrder status guard includes EXPIRED in status: { in: ['CREATED', 'FAILED', 'EXPIRED'] }.│
│ - Order transitions EXPIRED -> CAPTURED; user balance is credited.                               │
│ - Result: Customer receives purchased credits even if order was marked expired locally.          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Failure Modes & Operational Resilience

| Failure Scenario | System Behavior | Data Consistency Impact | Recovery Mechanism |
|---|---|---|---|
| **Razorpay API Down during Order Creation** | `createOrder` throws; caught in `RazorpayGatewayAdapter`; re-thrown as `BadGatewayException(502)`. | Clean: No `PaymentOrder` created in DB; no balance modified. | User sees friendly checkout error banner. |
| **Webhook Delivery Delayed (e.g. 5 minutes)** | Client polling times out after 50 seconds; UI displays timeout message. Webhook arrives at minute 5. | Consistent: Webhook captures order, updates `creditBalance`, appends ledger row. | Balance updates on next page visit or refresh. |
| **Worker Crashes during LLM Execution** | BullMQ job fails or times out; `ReviewService.runForQueue` catch block executes `markFailedAndRefund`. | Consistent: Review marked `FAILED`, credits refunded atomically via `PaymentsRepository.refundCreditsInTx`. | Automatic: User's credits restored immediately. |
| **Database Connection Fails during Review Creation** | `ReviewRepository.createSession` transaction fails and rolls back. | Clean: 0 credits deducted, no Review created. | Client receives HTTP 500; no credits lost. |
| **Network Drops after Server Commits Review** | Server commits review and deducts credits, but HTTP response does not reach client. | Consistent: Review exists in database with status `PENDING` and is processed by BullMQ. | User visits `/history` and finds the completed review. |
| **Drift between `User.creditBalance` and Ledger** | An out-of-band DB mutation causes balance mismatch. | Detected: `checkBalanceDrift()` detects divergence. | `reconcileUserBalance(userId)` restores balance to `SUM(CreditLedger.amount)`. |

---

## 9. Dead Code & Legacy Path Audit

| Artifact / Path | Previous Role | Current Status | Reachable in Production? |
|---|---|---|---|
| `credit.guard.ts` | Pre-deducted credits before validation | **Confirmed Dead & Deleted** | ❌ No (File removed) |
| `credit-refund.interceptor.ts` | Caught pipe errors to refund credits | **Confirmed Dead & Deleted** | ❌ No (File removed) |
| `credit-cost.decorator.ts` | Set `@CreditCost` route metadata | **Confirmed Dead & Deleted** | ❌ No (File removed) |
| `credit.guard.spec.ts` | Unit tests for old guard | **Confirmed Dead & Deleted** | ❌ No (File removed) |
| `credit-refund.interceptor.spec.ts` | Unit tests for old interceptor | **Confirmed Dead & Deleted** | ❌ No (File removed) |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Client environment variable | **Confirmed Dead & Removed** | ❌ No (Key delivered via API) |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Legacy env vars in `.env.example` | Documented as reserved/unused | ❌ No (Auth uses GitHub tokens) |
| `WalletProvider` (`context/wallet-context.tsx`)| Shared React Context | **Mounted in RootLayout, but unconsumed** | ⚠️ Instantiated, but bypassed by `useWallet.ts` |

---

## 10. Automated Testing & Verification Results

### 10.1 Test Execution Summary

```
================================================================================
VERIFICATION SUITE EXECUTION RESULTS (2026-08-15)
================================================================================

1. Monorepo Type-Check:
   Command: pnpm build:packages && pnpm type-check
   Result:  SUCCESS (Exit 0)
   Output:  @cra/types (Passed), @cra/ai (Passed), client (Passed), server (Passed)

2. Server Unit & Security Tests:
   Command: pnpm --filter server test
   Result:  SUCCESS (Exit 0)
   Suites:  30 passed, 30 total
   Tests:   163 passed, 163 total
   Highlights:
     - webhook.controller.spec.ts: 4/4 passed (HMAC, payload limits, event ID bounds)
     - payments.service.spec.ts: 11/11 passed (webhook routing, idempotency, SDK decoupling)
     - payments.repository.spec.ts: 13/13 passed (fail-closed amounts/currencies, P2002 races, drift reconciliation)
     - free-credit.spec.ts: 2/2 passed (signup grant, error handling)
     - review.repository.spec.ts: 10/10 passed (atomic in-tx deduction, refund delegation)
     - review.controller.spec.ts: 6/6 passed (DTO validation before service, 402 propagation)

3. Client Tests:
   Command: pnpm --filter client test
   Result:  SUCCESS (Exit 0)
   Suites:  10 passed, 10 total
   Tests:   16 passed, 16 total
   Highlights:
     - use-wallet.spec.ts: 2/2 passed (wallet fetching, start/stop polling)
     - use-review-stream.spec.tsx: passed
     - review-progress.spec.tsx: passed

4. Monorepo Linter:
   Command: pnpm lint
   Result:  SUCCESS (Exit 0)
   Output:  apps/client lint: Done, apps/server lint: Done (0 findings)

5. Full Monorepo Build:
   Command: pnpm build
   Result:  SUCCESS (Exit 0)
   Output:  @cra/types, @cra/ai, Next.js client production bundle, NestJS SWC server build
================================================================================
```

---

## 11. Production Invariant Verification Checklist

| Invariant ID | Statement | Implementation Mechanism | Verified By | Result | Confidence |
|---|---|---|---|---|---|
| **INV-01** | One payment cannot grant credits more than once. | `PaymentEvent.razorpayEventId` unique constraint + `PaymentOrder.status in ['CREATED', 'FAILED', 'EXPIRED'] -> CAPTURED` status guard. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-02** | Credits cannot be consumed beyond available balance. | Conditional SQL decrement `WHERE id = userId AND creditBalance >= cost` in `ReviewRepository.createSession` and `PaymentsRepository.deductCredits`. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-03** | Only HMAC-verified Razorpay webhooks can grant credits. | `RazorpayGatewayAdapter.verifyWebhookSignature` using timing-safe comparison before webhook routing. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-04** | A user cannot receive the signup welcome grant more than once. | PostgreSQL partial unique index `CreditLedger_userId_type_FREE_GRANT_key`. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-05** | A single review failure or cancellation cannot refund credits more than once. | `Review.status = 'PENDING'` transition guard + partial unique index `CreditLedger_reviewId_type_CONSUMPTION_REFUND_key`. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-06** | Every credit consumption ledger entry must be traceable to the specific review. | `ReviewRepository.createSession` writes `reviewId: review.id` in the creation transaction. `HistoryController.chat` passes `reviewId`. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-07** | Client-supplied prices, amounts, or credit counts are never trusted. | Server-side policy in `credit-cost.policy.ts` dictates all financial amounts and credit values. | Code Inspection | ✅ Enforced | High |
| **INV-08** | Client UI components reflect a single, consistent wallet balance across all pages. | React `WalletProvider` mounted in `RootLayout`. | Code Inspection | ⚠️ Broken (PRD-001) | High |
| **INV-09** | User credit balance matches the sum of immutable ledger transactions. | Dual-write transactional updates + `checkBalanceDrift` and `reconcileUserBalance` routines. | Automated Tests + Code Inspection | ✅ Enforced | High |
| **INV-10** | Abandoned payment orders expire deterministically. | 15-minute background interval sweeper + lazy expiration on order creation. | Automated Tests + Code Inspection | ✅ Enforced | High |

---

## 12. Detailed Audit Findings (PRD-001 – PRD-003)

```markdown
## PRD-001 — Incomplete Frontend Wallet Context Migration: UI Consumers Bypass WalletProvider

**Severity:** Medium
**Area:** Frontend / State Management / UX
**Status:** Open
**Confidence:** High

### Finding
`WalletProvider` and `useWalletContext` were implemented in `apps/client/context/wallet-context.tsx` and mounted in `apps/client/app/layout.tsx`. However, `apps/client/lib/use-wallet.ts` was not updated to delegate to `useWalletContext()`. All client components (`AppHeader`, `ReviewPageClient`, and `AccountPage`) continue to import `useWallet` from `@/lib/use-wallet`, which instantiates separate, independent `useState` hook instances.

### Previous Audit Finding
RZC-006 & RZC-007

### Intended Architecture
ADR-005 specified a single shared `WalletProvider` context so that all UI components share the same balance cache, deduplicate network fetches, and synchronize the navigation header badge in real-time when purchases or reviews settle.

### Actual Implementation
- [`apps/client/context/wallet-context.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/context/wallet-context.tsx): Implements `WalletProvider` and exports `useWalletContext()`.
- [`apps/client/app/layout.tsx:35`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/layout.tsx#L35): Wraps the application in `<WalletProvider>{children}</WalletProvider>`.
- [`apps/client/lib/use-wallet.ts:20-26`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts#L20-L26): Still maintains its own local `useState` containers (`balance`, `ledger`, `packages`, `isLoading`, `isPolling`).
- [`apps/client/components/layout/app-header.tsx:24`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/layout/app-header.tsx#L24): `const { balance } = useWallet(token)`
- [`apps/client/components/review/review-page-client.tsx:37`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/review/review-page-client.tsx#L37): `const { balance, refresh: refreshWallet } = useWallet(githubToken)`
- [`apps/client/app/account/page.tsx:25`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/account/page.tsx#L25): `const { balance, ledger, ... } = useWallet(token)`

### Verification
Code inspection & grep search for `useWalletContext`: `useWalletContext` has 0 callers outside its declaration file.

### Impact
- Redundant network traffic: Mounting `/account` or `/review` triggers two simultaneous `GET /payments/wallet` HTTP requests (one from `AppHeader`, one from the page).
- Stale UI: When a purchase settles on `/account` or a review completes on `/review`, `refreshWallet()` updates only the local page state. The header credit badge continues displaying stale credits until the page is manually reloaded.

### Residual Risk
Cosmetic and UX desynchronization; no backend financial corruption.
```

---

```markdown
## PRD-002 — Missing Migration File for CreditLedger @@index([reviewId])

**Severity:** Low
**Area:** Database / Migrations
**Status:** Open
**Confidence:** High

### Finding
`schema.prisma` includes `@@index([reviewId])` on the `CreditLedger` model to optimize queries searching for transactions associated with a review. However, no corresponding Prisma migration file was committed in `apps/server/prisma/migrations/`.

### Previous Audit Finding
Phase 2 Implementation Plan (Section 2.4)

### Intended Architecture
Phase 2 of the implementation plan called for generating a migration `add_credit_ledger_review_id_index` creating `CREATE INDEX "CreditLedger_reviewId_idx" ON "CreditLedger"("reviewId")`.

### Actual Implementation
- [`apps/server/prisma/schema.prisma:202`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/prisma/schema.prisma#L202): Contains `@@index([reviewId])`.
- [`apps/server/prisma/migrations/20260814000000_add_credit_ledger_unique_indexes/migration.sql`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/prisma/migrations/20260814000000_add_credit_ledger_unique_indexes/migration.sql): Contains the partial unique index `CreditLedger_reviewId_type_CONSUMPTION_REFUND_key` (which indexes only `type = 'CONSUMPTION_REFUND'`), but not the general `CreditLedger_reviewId_idx`.

### Verification
Inspected all SQL files in `apps/server/prisma/migrations/`.

### Impact
In environments deployed via `prisma migrate deploy`, the general index `CreditLedger_reviewId_idx` will not exist in PostgreSQL. Queries filtering `WHERE reviewId = ...` on `CONSUMPTION` entries will perform a sequential scan unless the migration is created and deployed.

### Residual Risk
Negligible at current scale; minor performance degradation on high-volume review ledger lookups.
```

---

```markdown
## PRD-003 — Chat Endpoint Pre-Deducts Credits Before Review Ownership Verification

**Severity:** Low
**Area:** Backend / Business Logic / Churn
**Status:** Open
**Confidence:** High

### Finding
In `POST /history/:id/chat`, `HistoryController.chat` invokes `this.paymentsService.deductCredits` before calling `this.historyService.chatGenerator(id, userId, ...)`. Inside `chatGenerator`, `this.getReview(id, userId)` checks if the review exists and belongs to the requesting user. If the review does not exist or belongs to another user, `getReview` throws `NotFoundException`, which causes the controller catch block to immediately issue a `refundCredits`.

### Intended Architecture
Input validation and ownership authorization should precede financial database mutations.

### Actual Implementation
- [`apps/server/src/history/history.controller.ts:62-98`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.controller.ts#L62-L98):
  ```typescript
  // Step 1: Deducts credit
  const balanceAfter = await this.paymentsService.deductCredits({
      userId,
      cost: CREDIT_COSTS.CHAT,
      reviewId: id,
      description: 'Follow-up chat query',
  })
  ...
  // Step 2: chatGenerator runs getReview(id, userId) -> throws NotFoundException if invalid
  const stream = this.historyService.chatGenerator(id, userId, dto.message, abort.signal)
  ...
  // Step 3: Catch block catches NotFoundException and refunds the 1 credit
  if (creditDeducted && emittedChunkCount === 0) {
      await this.paymentsService.refundCredits({ ... })
  }
  ```

### Verification
Code inspection of `HistoryController.chat` and `HistoryService.chatGenerator`.

### Impact
If a client sends requests with non-existent or inaccessible review IDs, the database executes a write (`CONSUMPTION`) and an immediate compensating write (`CONSUMPTION_REFUND`). While no credits are improperly lost, this introduces unnecessary database write churn and creates clutter in the user's ledger history.

### Residual Risk
Low; failure mode is self-healing via the refund catch block.
```

---

## 13. Production Readiness Scorecard

| Area | Status | Verified By | Confidence | Critical Findings | Summary Assessment |
|---|---|---|---|---|---|
| **Razorpay Payments** | ✅ Strong | Unit Tests + Code Inspection | High | None | Server-side pricing, immutable package credits, pending order caps. |
| **Payment Verification** | ✅ Strong | Unit Tests + Code Inspection | High | None | Constant-time HMAC comparison, signature format validation. |
| **Webhooks** | ✅ Strong | Unit Tests + Code Inspection | High | None | 1MB payload limit, event-ID validation, safe JSON handling. |
| **Entitlements** | ✅ Strong | Unit Tests + Code Inspection | High | None | Webhook-exclusive entitlement. No spoofable verify endpoint. |
| **Credit Grants** | ✅ Strong | Unit Tests + Code Inspection | High | None | Idempotent free signup grant + verified purchase credits. |
| **Credit Consumption** | ✅ Strong | Unit Tests + Code Inspection | High | None | In-transaction session creation + guaranteed `reviewId` linkage. |
| **Idempotency** | ✅ Strong | Unit Tests + Code Inspection | High | None | Dual-layer capture idempotency + partial unique indexes. |
| **Concurrency** | ✅ Strong | Unit Tests + Code Inspection | High | None | PostgreSQL conditional decrements prevent double spending. |
| **Database Integrity** | ⚠️ Minor Gap | Code Inspection | High | PRD-002 | `@@index([reviewId])` lacks a committed migration file. |
| **Security** | ✅ Strong | Unit Tests + Code Inspection | High | None | Timing-safe HMAC, rate limiting, no PII in external notes. |
| **Failure Recovery** | ✅ Strong | Unit Tests + Code Inspection | High | None | Atomic failure and cancellation refunds via `PaymentsRepository`. |
| **Testing** | ✅ Strong | Full Suite Run (179 tests) | High | None | 163 server + 16 client tests passing green; 0 lint errors. |
| **Observability** | ✅ Strong | Code Inspection | High | None | Structured logging tags (`[RZP_WEBHOOK_CAPTURED]`, etc.). |
| **Deployment** | ✅ Strong | Build Run | High | None | `pnpm build` succeeds; reverse proxy trust configured. |
| **Frontend State** | ⚠️ Needs Fix | Code Inspection | High | PRD-001 | `use-wallet.ts` does not consume `WalletProvider` context. |
| **Maintainability** | ✅ Strong | Code Inspection | High | None | `CreditGuard` dead code removed; `@Global() AuthModule`. |
| **Production Readiness**| ⚠️ Conditional| Full Audit | High | None Critical | **Core financial & database logic is production-ready. 1 medium frontend issue should be fixed before launch.** |

---

## 14. Final Production Recommendation

### Verdict: **⚠️ Conditionally Production Ready**

The backend billing engine, Razorpay gateway integration, database schema, concurrency controls, and failure recovery mechanisms are **genuinely production-ready and rock-solid**.

The previous architectural vulnerabilities (bypassed repositories, dead refund methods, unlinked consumption rows, and circular dependencies) have all been **thoroughly and effectively resolved**.

### Pre-Deployment Action Items

To reach full **✅ Production Ready** status, the following minor fixes should be applied:

1. **Wire `useWallet` to `useWalletContext` (Fix for PRD-001):**
   Update `apps/client/lib/use-wallet.ts` to delegate to `useWalletContext()` from `@/context/wallet-context.tsx`, ensuring that all client components share the single synchronized balance container.
2. **Generate Migration for `CreditLedger` Review Index (Fix for PRD-002):**
   Create a Prisma migration file creating `CREATE INDEX "CreditLedger_reviewId_idx" ON "CreditLedger"("reviewId");`.
3. **Move Review Ownership Check Before Chat Deduction (Fix for PRD-003):**
   In `HistoryController.chat`, call `await this.historyService.getReview(id, userId)` *before* calling `this.paymentsService.deductCredits`.
