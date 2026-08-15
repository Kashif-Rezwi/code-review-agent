# Comprehensive Razorpay & Credit Usage Architecture Audit

> **Document Version:** 1.0.0  
> **Audit Date:** 2026-08-15  
> **Target System:** Code Review Agent — Razorpay Payment Integration & Credit Wallet Subsystem  
> **Scope:** Full-stack static architectural audit, runtime boundary analysis, concurrency & idempotency review, data model integrity analysis, and production readiness assessment.  
> **Auditor Stance:** Objective, evidence-based, strictly solution-neutral. No solutions, refactorings, or migrations are proposed in this document.

---

## 1. Executive Summary

This document presents a comprehensive, repository-level architectural audit of the **Razorpay payment integration**, the **credit wallet/consumption subsystem**, and their coupling with authentication, user management, and the core AI code review engine in the **Code Review Agent** monorepo.

The implementation follows a **prepaid credit wallet model** where users purchase credit packs via Razorpay (INR) and consume credits to perform single-agent code reviews (5 credits), multi-agent clustered PR reviews (10 credits), and follow-up interactive chat sessions (1 credit).

### Core Architectural Strengths
1. **Server-Side Financial Authority:** Pricing (`CREDIT_PACKAGES`), credit operation costs (`CREDIT_COSTS`), and credit allocations are strictly defined server-side in [`credit-cost.policy.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-cost.policy.ts). No client-side price, amount, or credit grant is trusted.
2. **Webhook-Driven Credit Entitlement:** Credit grants occur strictly via backend HMAC-SHA256 verified webhooks (`POST /payments/webhook`). There is no client-side payment verification endpoint (`POST /payments/verify` does not exist), eliminating client-spoofed payment confirmations.
3. **Database Concurrency & Anti-Double-Spend Protections:**
   - Credit deduction uses atomic conditional SQL updates (`WHERE id = userId AND creditBalance >= cost`).
   - Order capture employs a 2-layer idempotency guard: unique `razorpayEventId` in `PaymentEvent` (layer 1) and status-guarded transition `status: { in: ['CREATED', 'FAILED', 'EXPIRED'] } -> CAPTURED` in `PaymentOrder` (layer 2).
   - Signup free-credit grant is protected by a PostgreSQL partial unique index (`CreditLedger_userId_type_FREE_GRANT_key`).
   - Review failure refunds are protected by a PostgreSQL partial unique index (`CreditLedger_reviewId_type_CONSUMPTION_REFUND_key`).

### Critical Architectural Debt & Production Risks
Despite the robust core primitives, the audit identified **14 architectural findings (RZC-001 through RZC-014)** spanning coupling, data traceability, lifecycle complexity, and operational safety:

1. **Bypassed Domain Boundaries & Logic Duplication (RZC-001):** `ReviewRepository` directly modifies `User.creditBalance` and appends `CreditLedger` rows inside `markFailedAndRefund` and `markCancelledAndRefund`, completely bypassing `PaymentsService` and `PaymentsRepository`.
2. **Dead Code in Payment Service (RZC-002):** `PaymentsService.refundCreditsInTx` and `PaymentsRepository.refundCreditsInTx` are dead code, as `ReviewRepository` duplicates their implementation inline.
3. **Broken Traceability on Consumption Ledger (RZC-003):** `CreditGuard` pre-deducts credits before review creation, inserting `CONSUMPTION` ledger rows with `reviewId = null`. The `reviewId` is never backfilled, making it impossible to audit which review consumed which credits.
4. **Fragile Multi-Layered Refund Architecture (RZC-004 & RZC-005):** Credit pre-deduction occurs in a NestJS Guard (before DTO validation pipe execution). This forces untyped request property mutations (`req.creditDeducted`), manual body inspection in `@CreditCost` decorators, and requires three distinct catch/refund layers across interceptors, controllers, and background workers.
5. **Decoupled Frontend Wallet State (RZC-006 & RZC-007):** `AppHeader` and `ReviewPageClient` maintain independent `useWallet` hook instances with no shared state or cache synchronization. Furthermore, client polling termination uses a brittle strict-greater-than check (`balance > initialBalance`) that fails if concurrent operations occur.
6. **No Ledger Reconciliation or Background Cleanup (RZC-009 & RZC-010):** `User.creditBalance` is a raw mutable integer with no reconciliation query against `SUM(CreditLedger.amount)`. Stale order expiration is only evaluated lazily upon new order creation, with no background cleanup job.

---

## 2. Repository & System Context

### Monorepo Architecture
The repository is a TypeScript monorepo managed with `pnpm` workspaces:

| Package / App | Path | Tech Stack | Role in Payment / Credit Lifecycle |
|---|---|---|---|
| `server` | [`apps/server`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server) | NestJS 11, Prisma 6, PostgreSQL (Neon) + pgvector, BullMQ + Redis, Razorpay SDK | API endpoints, payment webhook ingestion, credit ledger mutations, review processing |
| `client` | [`apps/client`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client) | Next.js 16 (App Router), React 19, NextAuth 4, Tailwind 4 | Account/wallet UI, Razorpay Checkout.js launcher, balance polling, review initiation |
| `@cra/types` | [`packages/types`](file:///Users/kashifrezwi/Developer/code-review-agent/packages/types) | TypeScript, Zod | Shared contracts: `CreditPackageSchema`, `LedgerEntrySchema`, `WalletResponseSchema` |
| `@cra/ai` | [`packages/ai`](file:///Users/kashifrezwi/Developer/code-review-agent/packages/ai) | Vercel AI SDK, OpenRouter | AI prompts, clustering, chunking |

### Surrounding Infrastructure Touchpoints
```
                        ┌────────────────────────┐
                        │      Razorpay API      │
                        └──────────┬─────────────┘
                                   │ Webhook (HMAC)
                                   ▼
┌──────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐
│  Next.js Client  ├───►│      NestJS Server     ├───►│   PostgreSQL (Prisma)  │
│  (NextAuth JWT)  │◄───┤  (AuthGuard / Payments)│◄───┤ (User, Orders, Ledger) │
└──────────────────┘    └──────────┬─────────────┘    └────────────────────────┘
                                   │ Job Dispatch
                                   ▼
                        ┌────────────────────────┐
                        │      Redis / BullMQ    │
                        │    (Review Worker)     │
                        └────────────────────────┘
```

---

## 3. Reconstructed Current Architecture

### 3.1 Component Inventory & Responsibilities

| Component | File Path | Primary Responsibility | Upstream Callers | Downstream Dependencies |
|---|---|---|---|---|
| `PaymentsController` | [`payments.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.controller.ts) | Exposes authenticated `POST /payments/order` and `GET /payments/wallet`. Applies rate limiting. | Frontend `api.ts` | `PaymentsService`, `AuthGuard`, `UserThrottlerGuard` |
| `WebhookController` | [`webhook.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/webhook.controller.ts) | Unauthenticated endpoint `POST /payments/webhook`. Enforces payload size, signature, and event-ID header constraints. | Razorpay Webhook Infrastructure | `PaymentsService`, `ThrottlerGuard` |
| `PaymentsService` | [`payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts) | Integrates with Razorpay SDK, executes HMAC-SHA256 verification, routes `order.paid` / `payment.failed`, coordinates wallet balance queries, deductions, and refunds. | `PaymentsController`, `WebhookController`, `CreditGuard`, `CreditRefundInterceptor`, `ReviewController`, `HistoryController`, `UsersService` | `PaymentsRepository`, Razorpay SDK, `ConfigService` |
| `PaymentsRepository` | [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts) | Executes Prisma database transactions (`$transaction`) for order creation, capture, failure, credit deductions, refunds, free grants, and order expiration. | `PaymentsService` | `PrismaService` (`User`, `PaymentOrder`, `PaymentEvent`, `CreditLedger`) |
| `CreditGuard` | [`credit.guard.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts) | NestJS CanActivate guard that reads `@CreditCost()` metadata, evaluates cost, pre-deducts credits via `PaymentsService.deductCredits`, and annotates `Request`. | Route handlers: `POST /review/session`, `POST /history/:id/chat` | `PaymentsService`, `Reflector` |
| `CreditRefundInterceptor` | [`credit-refund.interceptor.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-refund.interceptor.ts) | NestInterceptor wrapping route execution with `catchError` to refund pre-deducted credits if validation or subsequent pipes fail. | Route handlers: `POST /review/session`, `POST /history/:id/chat` | `PaymentsService` |
| `ReviewRepository` | [`review.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts) | Manages Review persistence. **Also performs direct mutations on `User.creditBalance` and `CreditLedger`** during failure and cancellation. | `ReviewService`, `ReviewProcessor` | `PrismaService` (`Review`, `ReviewDispatch`, `User`, `CreditLedger`) |
| `UsersService` | [`users.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/users/users.service.ts) | Upserts user profile on login and triggers `PaymentsService.grantFreeCredits`. | `AuthService` | `PaymentsService`, `PrismaService` (`User`) |
| `AccountPage` | [`app/account/page.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/account/page.tsx) | Renders wallet balance, package purchase options, transaction ledger, and loads Razorpay `checkout.js`. | Next.js Router (`/account`) | `useWallet`, `paymentsService` (`lib/api.ts`), Razorpay SDK script |
| `useWallet` | [`lib/use-wallet.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts) | Custom React hook managing wallet fetching, balance state, ledger state, and post-payment polling. | `AccountPage`, `AppHeader`, `ReviewPageClient` | `paymentsService` (`lib/api.ts`) |

---

## 4. Razorpay Architecture & Payment Lifecycle

### 4.1 End-to-End Payment Flow Diagram
```
 User Browser (/account)                  NestJS Server                       Razorpay API / Webhook
─────────────────────────                ─────────────                       ───────────────────────
            │                                  │                                         │
 1. Click "Buy Pack (50)"                      │                                         │
    POST /payments/order ─────────────────────►│                                         │
    { packageId: "50" }                        │ 2. Check pending order cap (< 3)        │
                                               │    Lookup package in CREDIT_PACKAGES    │
                                               │    orders.create({ amount: 9900 }) ────►│
                                               │◄── { id: "order_xyz", ... } ────────────│
                                               │ 3. INSERT INTO "PaymentOrder"           │
                                               │    (status: CREATED, creditsGranted: 50)│
    ◄──────────────────────────────────────────┤                                         │
    { orderId, razorpayOrderId, amount, ... }  │                                         │
            │                                  │                                         │
 4. new window.Razorpay(options).open()        │                                         │
    User completes payment ─────────────────────────────────────────────────────────────►│
            │                                  │                                         │
 5. Modal closes -> handler()                  │                                         │
    Trigger useWallet.startPolling()           │                                         │
    GET /payments/wallet (every 2.5s) ────────►│                                         │
            │                                  │ 6. POST /payments/webhook ◄─────────────│
            │                                  │    Headers: x-razorpay-signature,       │
            │                                  │             x-razorpay-event-id         │
            │                                  │ 7. Verify HMAC-SHA256(rawBody)          │
            │                                  │ 8. $transaction:                        │
            │                                  │    - INSERT "PaymentEvent"              │
            │                                  │    - Cross-check amount & currency      │
            │                                  │    - UPDATE "PaymentOrder" -> CAPTURED  │
            │                                  │    - UPDATE "User" creditBalance + 50   │
            │                                  │    - INSERT "CreditLedger" (PURCHASE)   │
            │                                  │◄────────────────────────────────────────┘
 9. Polling detects balance increase ─────────►│
    Polling stops; UI displays new balance     │
```

### 4.2 Payment State Machine
```
   ┌────────────────────────────────────────────────────────┐
   │                        CREATED                         │
   └───────┬───────────────────┬────────────────────┬───────┘
           │                   │                    │
  Webhook: │          Webhook: │            Lazy 30m│ timeout
order.paid │    payment.failed │        check on new│ order
           ▼                   ▼                    ▼
   ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
   │   CAPTURED    │   │    FAILED     │   │    EXPIRED     │
   │  (Terminal)   │   └───────┬───────┘   └────────┬───────┘
   └───────▲───────┘           │                    │
           │                   │ Retry payment      │ Late payment
           └───────────────────┴────────────────────┘
```
- **Supported Transitions:**
  - `CREATED -> CAPTURED` (via `order.paid` webhook)
  - `CREATED -> FAILED` (via `payment.failed` webhook)
  - `CREATED -> EXPIRED` (via `expireStaleOrders` when `createdAt < now - 30m`)
  - `FAILED -> CAPTURED` (via `order.paid` webhook retry)
  - `EXPIRED -> CAPTURED` (via `order.paid` late delivery capture)
- **Terminal State:** `CAPTURED` is terminal. Once captured, further events for that order result in `already_captured` no-ops.

---

## 5. Credit Architecture & Consumption Lifecycle

### 5.1 Credit Ownership & Unit
- **Entity Owner:** Individual `User` (keyed by GitHub numeric ID string).
- **Scope:** User-level prepaid wallet. No organization or workspace hierarchy exists.
- **Unit:** Integer credit. Fractions and decimals are not supported.

### 5.2 Credit Lifecycles & Operations

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CREDIT INFLOWS                                       │
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│ Operation                              │ Mechanism / Source                            │
├────────────────────────────────────────┼───────────────────────────────────────────────┤
│ Welcome Gift (25 credits)              │ `UsersService.findOrCreate` -> `FREE_GRANT`    │
│ Pack Purchase (50 / 200 / 500 credits) │ Razorpay `order.paid` webhook -> `PURCHASE`   │
│ Review Failure Refund (5 / 10 credits) │ `ReviewRepository.markFailedAndRefund`        │
│ Review Cancel Refund (5 / 10 credits)  │ `ReviewRepository.markCancelledAndRefund`     │
│ Pre-Handler Error Refund (5 / 10 / 1)  │ `CreditRefundInterceptor` / Controller catch  │
└────────────────────────────────────────┴───────────────────────────────────────────────┘
                                         │
                                         ▼
                               ┌───────────────────┐
                               │ User.creditBalance│
                               └─────────┬─────────┘
                                         │
                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                  CREDIT OUTFLOWS                                       │
├────────────────────────────────────────┬───────────────────────────────────────────────┤
│ Single Code Review (-5 credits)        │ `CreditGuard` on `POST /review/session`       │
│ Multi-Agent PR Review (-10 credits)    │ `CreditGuard` on `POST /review/session`       │
│ Interactive Follow-up Chat (-1 credit) │ `CreditGuard` on `POST /history/:id/chat`     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. State and Source-of-Truth Analysis

| State Domain | Primary Authoritative Source of Truth | Secondary / Replicated State | Synchronization Mechanism | Risk / Discrepancy Potential |
|---|---|---|---|---|
| **User Identity** | GitHub OAuth profile | `User` table in PostgreSQL | Upsert on authenticated request in `AuthService` | Profile changes on GitHub (name, avatar) sync only upon active login/request. |
| **Credit Balance** | `User.creditBalance` column in PostgreSQL | `balanceAfter` column in `CreditLedger` | Updated atomically inside Prisma `$transaction` | **No reconciliation job exists.** If `User.creditBalance` is mutated outside ledger transactions, it will permanently diverge from `SUM(CreditLedger.amount)`. |
| **Credit Packages & Costs** | `CREDIT_PACKAGES` and `CREDIT_COSTS` in [`credit-cost.policy.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-cost.policy.ts) | Hardcoded strings in `AccountPage`, `ReviewActionContainer`, `review.controller.ts` | Code constants manually updated across files | Inconsistency if pricing or costs change in policy without updating frontend display text or controller resolver functions. |
| **Order Status** | `PaymentOrder.status` in PostgreSQL | Razorpay Dashboard / Orders API | Webhook events (`order.paid`, `payment.failed`) | If webhook delivery fails or is blocked, order remains in `CREATED` or `EXPIRED` status indefinitely. |
| **Review Execution Status** | `Review.status` in PostgreSQL | Redis SSE event stream, `ReviewDispatch.status` | State updates committed to PostgreSQL; Redis is secondary replay | PostgreSQL is authoritative; streamer reconstructs state from DB if Redis fails. |

---

## 7. Critical Invariants

| Invariant ID | Invariant Statement | Implementation Status | Evidence / Enforcement Mechanism |
|---|---|---|---|
| **INV-01** | One payment cannot grant credits more than once. | ✅ Guaranteed | 2-layer guard: `PaymentEvent.razorpayEventId` unique constraint + `PaymentOrder.status in ['CREATED', 'FAILED', 'EXPIRED']` status transition guard in `captureOrder`. |
| **INV-02** | Users cannot consume more credits than their available balance. | ✅ Guaranteed | Conditional SQL decrement `WHERE id = userId AND creditBalance >= cost` in `deductCredits`. |
| **INV-03** | Only verified Razorpay payments can grant credit entitlement. | ✅ Guaranteed | `captureOrder` is only invoked from `handleOrderPaid`, which requires HMAC-SHA256 timing-safe signature verification. |
| **INV-04** | A user cannot receive the signup welcome grant more than once. | ✅ Guaranteed | PostgreSQL partial unique index `CreditLedger_userId_type_FREE_GRANT_key`. |
| **INV-05** | A single review failure or cancellation cannot refund credits multiple times. | ✅ Guaranteed | Status guard `where: { id: reviewId, status: 'PENDING' }` + partial unique index `CreditLedger_reviewId_type_CONSUMPTION_REFUND_key`. |
| **INV-06** | Every credit balance mutation must correspond to an append-only ledger entry. | ⚠️ Partially Guaranteed | Enforced across all standard service methods, but `ReviewRepository` directly implements balance and ledger mutations rather than using a single unified transaction pipeline. |
| **INV-07** | Every credit consumption ledger entry must be traceable to the specific operation/review. | ❌ Not Guaranteed | `CreditGuard` records `reviewId: null` on all `CONSUMPTION` entries; `reviewId` is never backfilled upon session creation (RZC-003). |
| **INV-08** | Client wallet UI must reflect authoritative backend balance. | ⚠️ Partially Guaranteed | No shared React state; `AppHeader` and `ReviewPageClient` maintain independent polling/fetching instances (RZC-006). |

---

## 8. Detailed Architectural Findings (RZC-001 – RZC-014)

```markdown
## RZC-001 — Domain Boundary Violation: ReviewRepository Directly Mutates Credit Balances and Ledger

**Severity:** High

**Area:** Coupling / Architecture / Database

**Confidence:** High

### Finding
`ReviewRepository` directly executes SQL mutations against `User.creditBalance` and inserts rows into `CreditLedger` inside `markFailedAndRefund` and `markCancelledAndRefund`, completely bypassing `PaymentsService` and `PaymentsRepository`.

### Evidence
- [`apps/server/src/review/review.repository.ts:91-113`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts#L91-L113):
  ```typescript
  // Step 3: Increment user's credit balance.
  await tx.user.updateMany({
      where: { id: refund.userId },
      data: { creditBalance: { increment: refund.cost } },
  })
  ...
  // Step 5: Append CONSUMPTION_REFUND ledger entry.
  await tx.creditLedger.create({
      data: {
          userId: refund.userId,
          type: 'CONSUMPTION_REFUND',
          amount: refund.cost,
          balanceAfter: updatedUser.creditBalance,
          reviewId,
          description: refund.description,
      },
  })
  ```
- [`apps/server/src/review/review.repository.ts:156-176`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts#L156-L176): Identical direct balance update and ledger creation inside `markCancelledAndRefund`.

### Current Behavior
When a review fails in the worker or is cancelled by a user, the review domain repository directly manipulates the user's financial balance and credit ledger tables.

### Expected / Invariant
All credit ledger operations and balance modifications should be encapsulated within the payments/billing domain layer. Domain repositories outside of billing should not directly execute balance increments or construct ledger entries.

### Impact
- Spreads credit mutation logic across multiple unbounded repository layers.
- Any change to credit ledger schema, audit rules, or balance calculation requires modifying both `payments/` and `review/` modules.
- Leaves dead methods in `PaymentsRepository` (see RZC-002).

### Related Components
- [`review.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts)
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)

### Related Findings
- RZC-002
```

---

```markdown
## RZC-002 — Dead Code: Unused Transactional Refund Methods in Payments Service and Repository

**Severity:** Low

**Area:** Dead Code / Maintainability

**Confidence:** High

### Finding
`PaymentsService.refundCreditsInTx` and `PaymentsRepository.refundCreditsInTx` were implemented to support transactional credit refunds within external `$transaction` blocks, but are never called anywhere in the active codebase.

### Evidence
- [`apps/server/src/payments/payments.service.ts:294-299`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts#L294-L299):
  ```typescript
  async refundCreditsInTx(
      tx: Prisma.TransactionClient,
      params: { userId: string; cost: number; reviewId: string; description: string },
  ): Promise<void> {
      return this.repo.refundCreditsInTx(tx, params)
  }
  ```
- [`apps/server/src/payments/payments.repository.ts:274-305`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts#L274-L305): Full implementation of `refundCreditsInTx`.
- Repo-wide search for `refundCreditsInTx` shows references exist only in the declaration itself and in its mock in `payments.service.spec.ts:25`. No production callers exist.

### Current Behavior
The methods exist, are exported, and have unit test mocks, but remain completely unused because `ReviewRepository` implements its own inline SQL queries instead.

### Expected / Invariant
The codebase should not maintain unused transactional methods that duplicate logic implemented elsewhere.

### Impact
Misleads developers and future maintainers into assuming that external modules use `PaymentsService.refundCreditsInTx` for transactional refunds.

### Related Components
- [`payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`review.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts)

### Related Findings
- RZC-001
```

---

```markdown
## RZC-003 — Data Model Traceability Gap: CONSUMPTION Ledger Entries Persisted With Null reviewId

**Severity:** Medium

**Area:** Data Model / Observability / Auditability

**Confidence:** High

### Finding
All `CONSUMPTION` entries in `CreditLedger` created for code reviews and PR reviews are permanently stored with `reviewId = null`. There is no foreign key or backfilled link connecting a credit deduction to the specific review that consumed it.

### Evidence
- [`apps/server/src/payments/credit.guard.ts:72-77`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts#L72-L77):
  ```typescript
  const balanceAfter = await this.paymentsService.deductCredits({
      userId,
      cost,
      reviewId: null,
      description: `Pre-deduction for ${context.getHandler()?.name ?? 'route'}`,
  })
  ```
- [`apps/server/src/review/review.controller.ts:42-45`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts#L42-L45):
  ```typescript
  async createSession(@Body() dto: CreateSessionDto, @Req() req: Request) {
      try {
          const review = await this.reviewService.createSession(dto.type, dto.input, req.user!.userId)
          return { reviewId: review.id }
  ```
- Search across the entire repository confirms that no query or update ever modifies the `CreditLedger` row to set `reviewId = review.id` after `createSession` succeeds.
- In contrast, `CONSUMPTION_REFUND` entries created in `ReviewRepository` do populate `reviewId: reviewId` ([`review.repository.ts:109`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts#L109)).

### Current Behavior
When credits are deducted for a review, the ledger entry has `reviewId: null` and `description: "Pre-deduction for createSession"`. If the review subsequently fails and is refunded, the refund ledger entry has `reviewId: "cuid..."` and `description: "Refund: PR review failed"`.

### Expected / Invariant
In a transactional ledger, consumption transactions should be traceable to the entity/resource that consumed the credits.

### Impact
- Impossible to query which review corresponded to a given `CONSUMPTION` ledger entry.
- Asymmetry between consumption (unlinked) and refund (linked) rows in financial audit logs.
- Financial records in `CreditLedger` cannot be joined to `Review` records for per-review billing reports.

### Related Components
- [`credit.guard.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts)
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`review.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts)
```

---

```markdown
## RZC-004 — Fragile Multi-Layered Refund Architecture Across Request & Background Boundaries

**Severity:** High

**Area:** Architecture / Concurrency / Error Handling

**Confidence:** High

### Finding
The system uses three disparate refund handling mechanisms across the request and job lifecycles, relying on untyped Express `Request` property mutation (`req.creditDeducted`) to coordinate state between guards, interceptors, controllers, and background workers.

### Evidence
- **Layer 1 (Pre-handler pipe failure):** [`credit-refund.interceptor.ts:46-81`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-refund.interceptor.ts#L46-L81) catches errors in `next.handle()`, reads `req.creditDeducted`, invokes `paymentsService.refundCredits`, clears markers, and rethrows.
- **Layer 2 (Handler synchronous failure):** [`review.controller.ts:46-66`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts#L46-L66) wraps `createSession` in a `try/catch`, reads `creditReq.creditDeducted`, invokes `paymentsService.refundCredits`, manually sets `creditReq.creditDeducted = undefined`, and rethrows.
- **Layer 3 (Asynchronous background worker failure):** [`review.service.ts:148-154`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.service.ts#L148-L154) catches worker failures in `runForQueue` and calls `ReviewRepository.markFailedAndRefund`.
- **Chat Stream Async Generator:** [`history.controller.ts:70-87`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.controller.ts#L70-L87) catches streaming failures inside an async IIFE, calls `paymentsService.refundCredits`, manually clears `creditReq.creditDeducted = undefined`, and emits an SSE error event.

### Current Behavior
Because credits are deducted before handler execution, each execution stage must know whether it is responsible for refunding and must manually clear request property markers to prevent downstream interceptors from double-refunding.

### Expected / Invariant
Credit deduction and refund lifecycles should follow a deterministic, single-responsibility pattern rather than relying on mutable request markers and manual catch-block clearances across multiple layers.

### Impact
- High cognitive load and defect surface.
- If a future developer adds a new route handler with `CreditGuard` but forgets either `CreditRefundInterceptor` or the manual catch-and-clear block, users will either lose credits on failure or experience double refunds.

### Related Components
- [`credit.guard.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts)
- [`credit-refund.interceptor.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-refund.interceptor.ts)
- [`review.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts)
- [`history.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.controller.ts)
- [`review.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.service.ts)

### Related Findings
- RZC-001
- RZC-005
```

---

```markdown
## RZC-005 — Credit Guard Pre-Deduction Precedes DTO Validation, Forcing Duplicated Body Validation

**Severity:** Medium

**Area:** Coupling / Under-Engineering / Architecture

**Confidence:** High

### Finding
In NestJS, Guards execute before Validation Pipes. Because `CreditGuard` pre-deducts credits, it must inspect `req.body` to resolve dynamic costs (e.g. `PR` vs `CODE`) before NestJS's `ValidationPipe` has validated the payload, forcing manual type validation inside decorator resolvers.

### Evidence
- [`apps/server/src/review/review.controller.ts:35-40`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts#L35-L40):
  ```typescript
  @CreditCost((req: Request) => {
      const type = (req.body as { type?: unknown } | undefined)?.type
      if (type === 'PR') return CREDIT_COSTS.PR_REVIEW
      if (type === 'CODE') return CREDIT_COSTS.CODE_REVIEW
      throw new BadRequestException('Invalid review type — must be CODE or PR')
  })
  ```
- [`apps/server/src/review/dto/create-session.dto.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/dto/create-session.dto.ts): Defines class-validator decorators for the same `type` field.
- [`apps/server/src/payments/credit.guard.ts:28-31`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts#L28-L31): Explicit comment noting:
  `// Security note (F-06): guards execute before ValidationPipe.`

### Current Behavior
When a request hits `POST /review/session`, the `@CreditCost` function manually parses `req.body` and throws a `BadRequestException` if invalid. If valid, `CreditGuard` deducts credits. Only after `CreditGuard` succeeds does NestJS's `ValidationPipe` run on `CreateSessionDto`. If `ValidationPipe` fails on another field (e.g. `input`), `CreditRefundInterceptor` is triggered to refund the deduction.

### Expected / Invariant
Request payloads should be validated by the validation pipeline before financial deductions are committed to the database.

### Impact
- Validation rules for `type` are duplicated between `review.controller.ts` and `CreateSessionDto`.
- Generates unnecessary database write-and-refund transaction churn whenever an invalid request payload is submitted.

### Related Components
- [`credit.guard.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts)
- [`review.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts)
- [`credit-refund.interceptor.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-refund.interceptor.ts)

### Related Findings
- RZC-004
```

---

```markdown
## RZC-006 — Client Wallet State Is Fragmented Across Independent Hook Instances

**Severity:** Medium

**Area:** Frontend / State Management / Inconsistency

**Confidence:** High

### Finding
The frontend lacks a shared wallet state or cache layer (e.g. React Context, Zustand, or SWR/React Query). Each component that needs credit balance invokes `useWallet(token)` independently, creating separate state containers with unsynchronized balances and multiple redundant network requests.

### Evidence
- [`apps/client/components/layout/app-header.tsx:24`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/layout/app-header.tsx#L24):
  `const { balance } = useWallet(token)`
- [`apps/client/components/review/review-page-client.tsx:37`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/review/review-page-client.tsx#L37):
  `const { balance, refresh: refreshWallet } = useWallet(githubToken)`
- [`apps/client/app/account/page.tsx:25`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/account/page.tsx#L25):
  `const { balance, ledger, packages, isLoading, isPolling, ... } = useWallet(token)`
- [`apps/client/lib/use-wallet.ts:21-26`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts#L21-L26): All state (`balance`, `ledger`, `packages`) is defined locally inside the hook instance using `useState`.

### Current Behavior
When the user visits `/review`, two separate HTTP requests for `GET /payments/wallet` are triggered simultaneously (one by `AppHeader`, one by `ReviewPageClient`). When a review completes on `ReviewPageClient` and calls `refreshWallet()`, only `ReviewPageClient`'s local balance updates; the `AppHeader` badge continues displaying the stale balance until the page is reloaded.

### Expected / Invariant
User credit balance and wallet data should be synchronized across all UI components on the client.

### Impact
- Visual discrepancy where the header badge shows an out-of-date credit balance while the page shows a different balance.
- Unnecessary duplicate network traffic against `GET /payments/wallet` on page mounts.

### Related Components
- [`use-wallet.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts)
- [`app-header.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/layout/app-header.tsx)
- [`review-page-client.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/review/review-page-client.tsx)
- [`account/page.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/account/page.tsx)
```

---

```markdown
## RZC-007 — Brittle Client-Side Polling Termination Condition in useWallet

**Severity:** Low

**Area:** Frontend / Race Condition / UX

**Confidence:** High

### Finding
The post-payment wallet polling mechanism in `useWallet` terminates only if `data.balance > initialBalanceRef.current`. If concurrent consumption occurs while polling is active, polling fails to recognize completion and continues running until timeout.

### Evidence
- [`apps/client/lib/use-wallet.ts:63-75`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts#L63-L75):
  ```typescript
  initialBalanceRef.current = balance
  ...
  pollingTimerRef.current = setInterval(async () => {
      ...
      const data = await fetchWallet()
      if (data && initialBalanceRef.current !== null && data.balance > initialBalanceRef.current) {
          stopPolling()
          return
      }
  ```

### Current Behavior
When a purchase completes, `startPolling()` captures `initialBalanceRef.current = balance`. If a user purchased 50 credits (e.g. balance 0 -> 50), but a background job simultaneously completed or another tab consumed 50 credits (net balance 0), `data.balance > initialBalanceRef.current` evaluates to `false`. Polling continues for the full 20 iterations (50 seconds) displaying a spinner.

### Expected / Invariant
Polling termination should reliably detect whether the specific transaction/order has settled, rather than relying on an aggregate net balance inequality.

### Impact
Sub-optimal user experience during concurrent activity; users may see a spinning "Syncing Wallet..." banner for 50 seconds even after payment settlement.

### Related Components
- [`use-wallet.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts)
- [`account/page.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/account/page.tsx)
```

---

```markdown
## RZC-008 — Circular Module Dependency Between AuthModule, UsersModule, and PaymentsModule

**Severity:** Medium

**Area:** Architecture / Coupling

**Confidence:** High

### Finding
There is a circular dependency between NestJS modules: `AuthModule -> UsersModule -> PaymentsModule -> forwardRef(() => AuthModule)`.

### Evidence
- [`apps/server/src/auth/auth.module.ts:10`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/auth/auth.module.ts#L10): `AuthModule` imports `UsersModule`.
- [`apps/server/src/users/users.module.ts:7`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/users/users.module.ts#L7): `UsersModule` imports `PaymentsModule` (to call `grantFreeCredits`).
- [`apps/server/src/payments/payments.module.ts:16`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.module.ts#L16): `PaymentsModule` imports `forwardRef(() => AuthModule)` (to inject `AuthGuard` in `PaymentsController`).

### Current Behavior
The circular dependency is resolved at runtime using NestJS's `forwardRef()`.

### Expected / Invariant
Module architectures should ideally form a directed acyclic graph (DAG) without circular references across authentication, user management, and billing.

### Impact
- Increases initialization fragility and tightly couples user authentication with payment domain providers.
- Can cause subtle `undefined` dependency injection or temporal dead zone runtime errors during testing or build optimizations if `forwardRef` is accidentally omitted.

### Related Components
- [`auth.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/auth/auth.module.ts)
- [`users.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/users/users.module.ts)
- [`payments.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.module.ts)
```

---

```markdown
## RZC-009 — Abandoned Order Expiration Is Lazy With No Background Reaper

**Severity:** Low

**Area:** Background Jobs / Under-Engineering / Database

**Confidence:** High

### Finding
Stale pending orders (`status: 'CREATED'`) older than 30 minutes are only expired when a user attempts to create a *new* order. There is no periodic background sweeper or BullMQ cron job to transition abandoned orders to `EXPIRED`.

### Evidence
- [`apps/server/src/payments/payments.repository.ts:393-415`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts#L393-L415):
  ```typescript
  async expireStaleOrders(userId?: string, maxAgeMs = ORDER_EXPIRY_MS): Promise<number> { ... }
  async countPendingOrders(userId: string): Promise<number> {
      await this.expireStaleOrders(userId)
      return this.prisma.paymentOrder.count({
          where: { userId, status: 'CREATED' },
      })
  }
  ```
- Search across the repo confirms `expireStaleOrders` is only called from `countPendingOrders(userId)` during `POST /payments/order`.

### Current Behavior
If a user creates 2 orders and abandons them without ever visiting or purchasing again, those orders remain in `CREATED` status indefinitely in the database.

### Expected / Invariant
Time-decayed state transitions should be managed deterministically by scheduled cleanup processes.

### Impact
- Low operational impact because `countPendingOrders` lazily clears stale orders before checking the cap, and `captureOrder` allows capturing `EXPIRED` orders if a late webhook arrives.
- Database records accumulate lingering `CREATED` orders that appear active in administrative queries.

### Related Components
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)
```

---

```markdown
## RZC-010 — Denormalized User.creditBalance Lacks Ledger Reconciliation & Drift Detection

**Severity:** Medium

**Area:** Data Integrity / Observability / Database

**Confidence:** High

### Finding
`User.creditBalance` is maintained as a raw denormalized integer on the `User` table. The application has no reconciliation routine, integrity check, or audit mechanism to verify that `User.creditBalance === SUM(CreditLedger.amount)`.

### Evidence
- [`apps/server/prisma/schema.prisma:23`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/prisma/schema.prisma#L23): `creditBalance Int @default(0)`
- All balance updates (`captureOrder`, `deductCredits`, `refundCredits`, `grantFreeCredits`, `markFailedAndRefund`, `markCancelledAndRefund`) execute dual writes: an `updateMany` on `User.creditBalance` followed by a `creditLedger.create`.
- Search across the entire repository reveals zero consistency checkers, integrity validation queries, or reconciliation scripts.

### Current Behavior
If an out-of-band database update, partial failure, or manual admin intervention alters `User.creditBalance` without writing to `CreditLedger`, or writes to `CreditLedger` without updating `User.creditBalance`, the balance permanently drifts without detection.

### Expected / Invariant
In dual-write ledger architectures (cached balance + transaction ledger), a reconciliation invariant `User.creditBalance == sum(CreditLedger.amount)` should be verifiable.

### Impact
Risk of undetected credit inflation or loss if database discrepancies occur.

### Related Components
- [`schema.prisma`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/prisma/schema.prisma)
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`review.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts)
```

---

```markdown
## RZC-011 — Full Credit Refund Emitted After Partial Chat Stream Delivery

**Severity:** Low

**Area:** Business Logic / Inconsistency

**Confidence:** High

### Finding
On the interactive chat endpoint (`POST /history/:id/chat`), 1 credit is pre-deducted before the stream begins. If an AI provider error occurs after several tokens have already been streamed to the user, the entire credit is refunded.

### Evidence
- [`apps/server/src/history/history.controller.ts:68-87`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.controller.ts#L68-L87):
  ```typescript
  try {
      for await (const chunk of stream) {
          subscriber.next({ data: { type: 'delta', text: chunk } })
      }
      subscriber.next({ data: { type: 'done' } })
  } catch (err) {
      ...
      // S-04: Refund pre-deducted credits if the chat stream failed
      if (creditReq.creditDeducted && creditReq.creditUserId) {
          void this.paymentsService.refundCredits({ ... })
      }
      subscriber.next({ data: { type: 'error', message } })
  }
  ```

### Current Behavior
If a chat stream emits 95% of a comprehensive answer and fails on the final token, the user receives the partial response and gets a 100% refund of the 1 credit. Conversely, if the user explicitly aborts/disconnects (`if (abort.signal.aborted) return`), no refund is issued.

### Expected / Invariant
Consistent policy on whether interrupted output constitutes free usage or consumed usage.

### Impact
Minor financial leakage on failed LLM chat streams; user-favorable failure mode.

### Related Components
- [`history.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.controller.ts)
```

---

```markdown
## RZC-012 — Absence of Operational Telemetry, Alerting, & Admin Tooling for Payment Failures

**Severity:** Medium

**Area:** Observability / Operational Safety

**Confidence:** High

### Finding
The payment integration lacks structured operational metrics, alerting hooks, and administrative interfaces. Revenue-impacting failure events (such as paid webhooks with no local order, amount mismatches, or zero-credit packages) log error messages to standard output but do not emit metrics or alert operators.

### Evidence
- [`apps/server/src/payments/payments.service.ts:201-210`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts#L201-L210):
  ```typescript
  case 'not_found':
      this.logger.error(`order.paid: no local order found for ${razorpayOrderId} — may be from a different environment`)
      break
  case 'zero_credits':
      this.logger.error(`order.paid: order ${razorpayOrderId} has zero credits — entitlement missing, left for reconciliation`)
      break
  ```
- [`apps/server/src/payments/payments.repository.ts:107-121`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts#L107-L121):
  `this.logger.error('[F-09] Mismatch on order ... Credits NOT granted.')`
- No Prometheus metrics, Sentry tags, or webhook failure alerts are integrated. No admin endpoints exist to view uncaptured payments or execute manual credit adjustments.

### Current Behavior
When an amount mismatch or missing order occurs on a real payment, the order is flagged in `PaymentEvent` and logged to stdout, but the customer remains uncredited without automated operator notification.

### Expected / Invariant
A production billing system must provide operational visibility and alerting for unfulfilled paid transactions.

### Impact
If a payment error occurs in production, operators will only discover the issue if the customer manually contacts support.

### Related Components
- [`payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`webhook.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/webhook.controller.ts)
```

---

```markdown
## RZC-013 — Direct Coupling to Razorpay SDK and Payload Structures

**Severity:** Low

**Area:** Abstraction Quality / Coupling

**Confidence:** High

### Finding
`PaymentsService` directly instantiates the concrete `Razorpay` SDK client and directly couples to Razorpay-specific payload paths (`payload.order.entity.id`, `payload.payment.entity.order_id`, paise currency units, INR defaults).

### Evidence
- [`apps/server/src/payments/payments.service.ts:33-36`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts#L33-L36):
  ```typescript
  this.razorpay = new Razorpay({
      key_id: this.config.getOrThrow<string>('RAZORPAY_KEY_ID'),
      key_secret: this.config.getOrThrow<string>('RAZORPAY_KEY_SECRET'),
  })
  ```
- [`apps/server/src/payments/payments.service.ts:157-160`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts#L157-L160) & [`225-230`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts#L225-L230): Direct extraction of Razorpay nested payload entities.

### Current Behavior
The billing subsystem is tightly coupled to Razorpay's specific API conventions.

### Expected / Invariant
Domain logic should ideally interact with payment gateway abstractions rather than embedding provider-specific payload navigation throughout core services.

### Impact
Makes unit testing require complex mock objects for the external SDK and prevents straightforward migration or expansion to alternative payment gateways (e.g. Stripe, LemonSqueezy) without rewriting `PaymentsService`.

### Related Components
- [`payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)
- [`payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
```

---

```markdown
## RZC-014 — Webhook Controller IP Throttler Vulnerable to Proxy Bypassing or Collisions

**Severity:** Low

**Area:** Security / Infrastructure / Idempotency

**Confidence:** Medium

### Finding
`WebhookController` applies `@UseGuards(ThrottlerGuard)` with `@Throttle({ default: { limit: 100, ttl: 60_000 } })`. In a standard NestJS configuration behind reverse proxies or load balancers (e.g. Cloudflare, Render, Kubernetes Ingress), `ThrottlerGuard` relies on `req.ip`. Without explicit trusted proxy configuration, all webhooks may share the same proxy IP or bypass the rate limiter via spoofed `X-Forwarded-For` headers.

### Evidence
- [`apps/server/src/payments/webhook.controller.ts:33-34`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/webhook.controller.ts#L33-L34):
  `@UseGuards(ThrottlerGuard)`
  `@Throttle({ default: { limit: 100, ttl: 60_000 } })`
- [`apps/server/src/main.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/main.ts): Express app bootstrap does not configure `app.set('trust proxy', true)`.

### Current Behavior
In production deployments behind reverse proxies, `req.ip` resolves to the immediate upstream load balancer's IP address. All incoming webhooks from Razorpay share the same rate-limit bucket.

### Expected / Invariant
Rate limiting on webhook endpoints should operate on authenticated gateway semantics or accurately resolved upstream client IPs.

### Impact
If Razorpay delivers a high burst of webhook events across multiple simultaneous customer transactions, all requests count against the shared proxy IP bucket and may be prematurely throttled with HTTP 429.

### Related Components
- [`webhook.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/webhook.controller.ts)
- [`main.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/main.ts)
```

---

## 9. Failure Mode & Boundary Analysis

| Scenario | System Behavior | Data Consistency Result | Recovery / Failure Boundary |
|---|---|---|---|
| **Razorpay API Down during Order Creation** | `orders.create` throws; caught and logged in `payments.service.ts:70-75`; re-thrown as `BadGatewayException(502)`. | No `PaymentOrder` created in DB; no balance modified. | Clean failure. User sees error banner on client. |
| **User Pays, but Webhook Delivery Delayed (e.g. 10m)** | Client polls for 50s (20 attempts @ 2.5s) and times out; UI stops polling. Webhook arrives at minute 10. | Webhook captures order, updates status to `CAPTURED`, increments `User.creditBalance` and appends `CreditLedger`. | Safe. Balance updates upon next page visit or manual refresh. |
| **Razorpay Delivers Duplicate Webhooks Concurrently** | Both requests enter `captureOrder`. First commits `PaymentEvent` and captures order. Second receives `P2002` on `razorpayEventId` or `already_captured`. | Exactly-once credit grant. No duplicate balance increment. | Safe. Handled by dual-layer idempotency. |
| **Webhook Delivery for Non-Existent Local Order** | `captureOrder` does not find order; creates `PaymentEvent` with `razorpayOrderId: null` and returns `not_found`. Logs error. | Event stored for audit without foreign key constraint error. No credits granted. | Safe. Logged for manual inspection. |
| **Amount or Currency Mismatch in Webhook** | `captureOrder` compares `amountPaidPaise` and `currency` against `localOrder`. Mismatch detected -> creates `PaymentEvent` (`order.paid.amount_mismatch`). | Status remains `CREATED`; no balance increment; no credits granted. | Safe (fail-closed). Logged for manual reconciliation. |
| **Review Creation Fails Synchronously in Handler** | `ReviewController.createSession` catch block catches error, calls `paymentsService.refundCredits`, and clears request markers. | Balance incremented back; `CONSUMPTION_REFUND` ledger row appended. | Safe. User credits restored. |
| **Review Worker Fails in Background Queue** | `ReviewService.runForQueue` catch block calls `ReviewRepository.markFailedAndRefund`. Transitions review to `FAILED` and refunds balance in single `$transaction`. | Balance incremented; `CONSUMPTION_REFUND` ledger row appended with `reviewId`. | Safe. Atomic database transaction. |
| **User Cancels Review in Progress** | `ReviewController.cancelReview` calls `ReviewService.cancelReview` -> `markCancelledAndRefund`. Transitions review & dispatch to `CANCELLED` and refunds balance. | Balance incremented; `CONSUMPTION_REFUND` ledger row appended. | Safe. Cancelled jobs do not double-spend. |

---

## 10. Production Readiness Scorecard

| Assessment Dimension | Status | Confidence | Summary Evaluation & Key Findings |
|---|---|---|---|
| **Razorpay Integration** | ✅ Strong | High | Secure HMAC verification, fail-closed amount/currency checks, clean order lifecycle handling. |
| **Credit Architecture** | ⚠️ Needs Attention | High | Solid atomic conditional decrements, but consumption ledger rows lack `reviewId` linkage (RZC-003). |
| **Payment ↔ Credit Consistency** | ✅ Strong | High | Strict server-side authority; credits granted exclusively via verified webhooks. |
| **Idempotency** | ✅ Strong | High | Dual-layer idempotency on capture; partial unique indexes on free grants and review refunds. |
| **Concurrency** | ✅ Strong | High | PostgreSQL row locks prevent double-spending; transactional status guards prevent duplicate captures. |
| **Database Integrity** | ⚠️ Needs Attention | High | Denormalized balance lacks reconciliation routines (RZC-010); `review.repository` bypasses domain boundaries (RZC-001). |
| **Security** | ✅ Strong | High | Timing-safe HMAC check, payload size guards, no client payment verification, PII omitted from notes. |
| **Failure Handling** | ⚠️ Needs Attention | High | Robust refunding, but relies on a complex, fragile multi-layer request-marker pattern (RZC-004, RZC-005). |
| **Observability** | ⚠️ Needs Attention | High | Comprehensive events stored in DB, but lacks telemetry metrics, structured tracing, and operator alerts (RZC-012). |
| **Testing** | ✅ Strong | High | 163 server unit tests + 16 client tests passing green; excellent coverage of edge/security cases. |
| **Maintainability** | ⚠️ Needs Attention | High | Domain leakage in `ReviewRepository` (RZC-001), dead code (RZC-002), and circular module references (RZC-008). |
| **Coupling** | ⚠️ Needs Attention | High | High coupling between guard execution, request markers, and controller exception filters (RZC-004, RZC-005). |
| **Frontend State** | ⚠️ Needs Attention | High | Independent `useWallet` hook instances cause desynchronized UI badge states across pages (RZC-006, RZC-007). |
| **Overall Production Readiness** | ⚠️ Needs Attention | High | **Core financial & concurrency logic is secure and production-safe.** Architectural debt (coupling, missing reviewId link, fragmented frontend state, and lack of operational telemetry) should be addressed before high-scale production launch. |

---

## 11. Conclusion & Handoff to Solution Design Phase

The current Razorpay and credit wallet implementation has **sound financial security, robust concurrency controls, and comprehensive unit test coverage**. Its core invariants (anti-double-spend, idempotent capture, fail-closed webhook validation) are fully guaranteed at the database level.

However, the architecture exhibits **domain boundary leakage (`ReviewRepository` modifying credit balances directly), data model gaps (unlinked consumption ledger rows), high lifecycle coupling (guard pre-deductions requiring mutable request markers and multi-layer refund handlers), and frontend state fragmentation**.

This audit report serves as the authoritative, evidence-backed foundation for the subsequent architecture and redesign phase.
