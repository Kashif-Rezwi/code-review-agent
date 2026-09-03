# Razorpay & Credit Architecture — Concrete Implementation Plan

> **Document Version:** 1.0.0  
> **Status:** Implementation Blueprint (Ready for Execution)  
> **Target System:** Code Review Agent Monorepo (`apps/server`, `apps/client`, `packages/types`)  
> **Companion Document:** [`docs/architecture/razorpay-credit-architecture.md`](file:///Users/kashifrezwi/Developer/code-review-agent/docs/architecture/razorpay-credit-architecture.md)  
> **Purpose:** Step-by-step, phased instructions designed to be executed autonomously by an AI coding agent without requiring further architectural decisions.

---

## 1. Plan Overview & Execution Strategy

This implementation plan translates the target architecture into **8 strictly ordered, test-verified phases**. Every phase builds incrementally upon the previous phase, maintaining a green build and passing test suite throughout the transition.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PHASED IMPLEMENTATION PIPELINE                                 │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Phase 1: Gateway Abstraction & Core Module Decoupling (ADR-004, ADR-006)                         │
│ Phase 2: Database Integrity, Indexes & Reconciliation Routines (RZC-003, RZC-010)                │
│ Phase 3: Service-Level Atomic Credit Consumption & Review Session Integration (ADR-001, ADR-007) │
│ Phase 4: Chat Consumption & Stream Error Refactoring (RZC-011)                                   │
│ Phase 5: Webhooks, Background Sweeper & Operational Telemetry (RZC-009, RZC-012, RZC-014)        │
│ Phase 6: Frontend Shared Wallet Context & Polling Optimization (ADR-005, RZC-006, RZC-007)       │
│ Phase 7: Dead Code Removal & Obsolete Guard Elimination (RZC-002, RZC-004, RZC-005)              │
│ Phase 8: End-to-End Verification, Monorepo Lint & Production Sign-off                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phase-by-Phase Execution Instructions

---

### Phase 1: Gateway Abstraction & Core Module Decoupling

#### 1.1 Objective
Decouple `PaymentsService` from the concrete Razorpay SDK by introducing a `RazorpayGatewayAdapter`, and eliminate the circular module dependency (`AuthModule <-> UsersModule <-> PaymentsModule`) by making `AuthModule` global.

#### 1.2 Prerequisites
Baseline tests passing: `pnpm --filter server test`.

#### 1.3 Files Affected
- [`apps/server/src/payments/gateway/razorpay-gateway.adapter.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/gateway/razorpay-gateway.adapter.ts) *(NEW)*
- [`apps/server/src/payments/gateway/payment-gateway.interface.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/gateway/payment-gateway.interface.ts) *(NEW)*
- [`apps/server/src/payments/payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)
- [`apps/server/src/payments/payments.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.module.ts)
- [`apps/server/src/auth/auth.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/auth/auth.module.ts)

#### 1.4 Detailed Instructions
1. **Create Payment Gateway Interface & Adapter:**
   - Define `PaymentGateway` interface: `createOrder(amountPaise: number, currency: string, receipt: string, notes: Record<string, string>): Promise<{ id: string; amount: number; currency: string }>` and `verifyWebhookSignature(rawBody: Buffer, signature: string): boolean`.
   - Implement `RazorpayGatewayAdapter` injecting `ConfigService` and encapsulating `new Razorpay(...)` and `crypto.timingSafeEqual` signature checks.
2. **Refactor `PaymentsService`:**
   - Inject `PaymentGateway` into `PaymentsService` instead of instantiating `new Razorpay(...)` in the constructor.
3. **Decouple Module Hierarchy (ADR-004):**
   - Add `@Global()` decorator to `AuthModule` in [`auth.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/auth/auth.module.ts).
   - Remove `forwardRef(() => AuthModule)` from `PaymentsModule` in [`payments.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.module.ts).
   - Remove `imports: [forwardRef(() => AuthModule)]` from `payments.module.ts`.

#### 1.5 Testing & Validation
- Run `pnpm --filter server test` to verify `payments.service.spec.ts` passes with adapter mocking.
- Run `pnpm type-check` to ensure no circular type or module errors.

#### 1.6 Completion Criteria
`PaymentsService` interacts only with `PaymentGateway`, and `forwardRef` is eliminated from `payments.module.ts`.

---

### Phase 2: Database Integrity, Indexes & Reconciliation Routines

#### 2.1 Objective
Enhance database indexing for `CreditLedger.reviewId`, add the balance drift detection query and automated reconciliation method in `PaymentsRepository`.

#### 2.2 Prerequisites
Phase 1 complete.

#### 2.3 Files Affected
- [`apps/server/prisma/schema.prisma`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/prisma/schema.prisma)
- [`apps/server/src/payments/payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)
- [`apps/server/src/payments/payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)

#### 2.4 Detailed Instructions
1. **Schema & Migration:**
   - Add index `@@index([reviewId])` to `CreditLedger` in `schema.prisma`.
   - Create a Prisma migration if required (`npx prisma migrate dev --name add_credit_ledger_review_id_index`).
2. **Reconciliation Method in `PaymentsRepository`:**
   - Implement `checkBalanceDrift(userId?: string)` using raw SQL:
     ```typescript
     async checkBalanceDrift(userId?: string): Promise<Array<{ userId: string; cachedBalance: number; ledgerSum: number; drift: number }>> {
         return this.prisma.$queryRaw`
             SELECT 
                 u.id AS "userId",
                 u."creditBalance" AS "cachedBalance",
                 COALESCE(SUM(l.amount), 0)::int AS "ledgerSum",
                 (u."creditBalance" - COALESCE(SUM(l.amount), 0)::int) AS "drift"
             FROM "User" u
             LEFT JOIN "CreditLedger" l ON u.id = l."userId"
             ${userId ? Prisma.sql`WHERE u.id = ${userId}` : Prisma.empty}
             GROUP BY u.id, u."creditBalance"
             HAVING u."creditBalance" != COALESCE(SUM(l.amount), 0)::int
         `
     }
     ```
   - Implement `reconcileUserBalance(userId: string)` to atomically calculate `SUM(CreditLedger.amount)` and update `User.creditBalance` if drift exists.
3. **Expose in `PaymentsService`:**
   - Add `PaymentsService.reconcileUserBalance(userId: string)`.

#### 2.5 Testing & Validation
- Add unit tests in `payments.repository.spec.ts` testing `checkBalanceDrift` and `reconcileUserBalance`.

#### 2.6 Completion Criteria
Reconciliation routine exists and can detect/correct discrepancies between `User.creditBalance` and `SUM(CreditLedger.amount)`.

---

### Phase 3: Service-Level Atomic Credit Consumption & Review Session Integration

#### 3.1 Objective
Move credit deduction directly into `ReviewService.createSession` within a single interactive transaction, linking `reviewId` to `CreditLedger` at millisecond zero and delegating failure refunds to `PaymentsRepository.refundCreditsInTx`.

#### 3.2 Prerequisites
Phase 2 complete.

#### 3.3 Files Affected
- [`apps/server/src/review/review.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.service.ts)
- [`apps/server/src/review/review.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.repository.ts)
- [`apps/server/src/review/review.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/review/review.controller.ts)
- [`apps/server/src/payments/payments.repository.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.repository.ts)

#### 3.4 Detailed Instructions
1. **Atomic Session Creation in `ReviewRepository.createSession` / `ReviewService.createSession`:**
   - Update `createSession(type: 'CODE' | 'PR', input: string, userId: string, creditCost: number)` to run inside `$transaction`:
     1. Decrement user balance conditionally:
        ```typescript
        const deducted = await tx.user.updateMany({
            where: { id: userId, creditBalance: { gte: creditCost } },
            data: { creditBalance: { decrement: creditCost } },
        })
        if (deducted.count === 0) {
            throw new HttpException('Insufficient credits. Please top up your balance.', HttpStatus.PAYMENT_REQUIRED)
        }
        ```
     2. Create `Review` entity (`status: 'PENDING'`).
     3. Create `ReviewDispatch` entity (`status: 'PENDING'`).
     4. Read updated `User.creditBalance`.
     5. Create `CreditLedger` entity:
        ```typescript
        await tx.creditLedger.create({
            data: {
                userId,
                type: 'CONSUMPTION',
                amount: -creditCost,
                balanceAfter: updatedUser.creditBalance,
                reviewId: review.id, // RZC-003: Guaranteed link at millisecond zero!
                description: `${type === 'PR' ? 'PR' : 'Code'} review session`,
            },
        })
        ```
2. **Refactor Review Controller (`POST /review/session`):**
   - Remove `@UseGuards(CreditGuard)`.
   - Remove `@UseInterceptors(CreditRefundInterceptor)`.
   - Remove `@CreditCost(...)`.
   - Controller simply receives validated `CreateSessionDto`, determines cost via `getReviewCreditCost(dto.type)`, and calls `this.reviewService.createSession(dto.type, dto.input, req.user!.userId)`.
   - Remove manual try/catch refund blocks from `ReviewController.createSession`.
3. **Refactor `ReviewRepository` Failure & Cancelled Refunds (ADR-007, RZC-001, RZC-002):**
   - In `markFailedAndRefund` and `markCancelledAndRefund`, replace inline `tx.user.updateMany` and `tx.creditLedger.create` with calls to `this.paymentsRepository.refundCreditsInTx(tx, { userId: refund.userId, cost: refund.cost, reviewId, description: refund.description })`.

#### 3.5 Testing & Validation
- Run `pnpm --filter server test` — verify `review.controller.spec.ts`, `review.service.spec.ts`, and `review.repository.spec.ts` pass.
- Verify that `CreditLedger` created during review creation contains valid `reviewId`.

#### 3.6 Completion Criteria
Review session creation and credit deduction are atomic; `reviewId` is always populated on `CONSUMPTION` ledger rows; `ReviewRepository` delegates refunds to `PaymentsRepository`.

---

### Phase 4: Chat Consumption & Stream Error Refactoring

#### 4.1 Objective
Refactor interactive chat endpoint (`POST /history/:id/chat`) to perform direct service-level deduction and clear stream error refund policy.

#### 4.2 Prerequisites
Phase 3 complete.

#### 4.3 Files Affected
- [`apps/server/src/history/history.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.controller.ts)
- [`apps/server/src/history/history.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/history/history.service.ts)

#### 4.4 Detailed Instructions
1. **Chat Controller Cleanup:**
   - Remove `@UseGuards(CreditGuard)` and `@UseInterceptors(CreditRefundInterceptor)` from `POST :id/chat`.
   - Remove `@CreditCost(CREDIT_COSTS.CHAT)` decorator.
2. **Service-Level Chat Deduction:**
   - In `HistoryService` (or in chat controller before streaming begins), call:
     ```typescript
     const balanceAfter = await this.paymentsService.deductCredits({
         userId,
         cost: CREDIT_COSTS.CHAT,
         reviewId: id,
         description: 'Follow-up chat query',
     })
     if (balanceAfter === null) {
         throw new HttpException('Insufficient credits for chat.', HttpStatus.PAYMENT_REQUIRED)
     }
     ```
3. **Stream Error Policy (RZC-011):**
   - If stream errors before emitting the first delta, invoke `this.paymentsService.refundCredits({ userId, cost: CREDIT_COSTS.CHAT, reviewId: id, description: 'Refund: chat stream failed' })`.
   - Client disconnects via `abort.signal` do not issue a refund once streaming was initiated.

#### 4.5 Testing & Validation
- Run `pnpm --filter server test` for history controller and service specs.

#### 4.6 Completion Criteria
Chat endpoint operates without `CreditGuard` and records `reviewId` directly on chat consumption ledger entries.

---

### Phase 5: Webhooks, Background Sweeper & Operational Telemetry

#### 5.1 Objective
Harden webhook processing behind reverse proxies (`trust proxy`), implement scheduled background order expiration, and add structured operational logging for payment anomalies.

#### 5.2 Prerequisites
Phase 4 complete.

#### 5.3 Files Affected
- [`apps/server/src/main.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/main.ts)
- [`apps/server/src/payments/webhook.controller.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/webhook.controller.ts)
- [`apps/server/src/payments/payments.service.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.service.ts)
- [`apps/server/src/queue/queue.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/queue/queue.module.ts) *(or scheduled task provider)*

#### 5.4 Detailed Instructions
1. **Reverse Proxy Configuration (RZC-014):**
   - In `apps/server/src/main.ts`, configure Express instance:
     ```typescript
     const app = await NestFactory.create<NestExpressApplication>(AppModule)
     app.set('trust proxy', 1)
     ```
2. **Structured Operational Telemetry (RZC-012):**
   - In `PaymentsService` and `PaymentsRepository`, log payment events with structured tags:
     - `[PAYMENT_UNMATCHED_ORDER]` when webhook arrives for unknown local order.
     - `[PAYMENT_AMOUNT_MISMATCH]` when amount/currency differs.
     - `[PAYMENT_ZERO_CREDITS]` when paid order has zero credits.
     - `[PAYMENT_CAPTURED]` on successful order capture.
3. **Background Order Reaper (RZC-009):**
   - Register a periodic background task or BullMQ repeatable job `payments:expire-stale-orders` running every 15 minutes calling `paymentsRepository.expireStaleOrders()`.

#### 5.5 Testing & Validation
- Run `pnpm --filter server test` — verify `webhook.controller.spec.ts` and `payments.service.spec.ts`.

#### 5.6 Completion Criteria
Server trusts proxy headers, stale orders are reaped periodically, and critical payment anomalies emit structured operational tags.

---

### Phase 6: Frontend Shared Wallet Context & Polling Optimization

#### 6.1 Objective
Introduce a unified `WalletProvider` React Context at the client application root to share wallet balance across all UI components and terminate post-payment polling deterministically.

#### 6.2 Prerequisites
Phase 5 complete.

#### 6.3 Files Affected
- [`apps/client/context/wallet-context.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/context/wallet-context.tsx) *(NEW)*
- [`apps/client/lib/use-wallet.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/lib/use-wallet.ts)
- [`apps/client/components/layout/app-header.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/layout/app-header.tsx)
- [`apps/client/components/review/review-page-client.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/components/review/review-page-client.tsx)
- [`apps/client/app/account/page.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/account/page.tsx)
- [`apps/client/app/layout.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/layout.tsx)

#### 6.4 Detailed Instructions
1. **Create `WalletProvider` & Context (`apps/client/context/wallet-context.tsx`):**
   - Maintain shared `balance`, `ledger`, `packages`, `isLoading`, `isPolling`, `error`.
   - Provide `refreshWallet()`, `startPolling({ targetOrderId?: string, expectedCredits?: number })`, and `stopPolling()`.
   - In polling loop, check if `ledger.some(e => e.orderId === targetOrderId)` OR `balance >= initialBalance + expectedCredits`. When matched, stop polling immediately.
2. **Mount in Root Layout:**
   - Wrap application children with `WalletProvider` inside [`app/layout.tsx`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/client/app/layout.tsx).
3. **Update UI Consumers (RZC-006, RZC-007):**
   - Update `useWallet()` to consume `useContext(WalletContext)`.
   - When a review finishes in `ReviewPageClient`, calling `refreshWallet()` automatically updates the `AppHeader` badge in real-time.
   - In `AccountPage`, `startPolling({ targetOrderId: order.id })` terminates cleanly once the webhook settles.

#### 6.5 Testing & Validation
- Run `pnpm --filter client test` — verify `use-wallet.spec.ts` and component tests pass.

#### 6.6 Completion Criteria
All client components share synchronized wallet state with zero duplicate fetches on page load and deterministic polling termination.

---

### Phase 7: Dead Code Removal & Obsolete Abstraction Elimination

#### 7.1 Objective
Remove retired guards, interceptors, decorators, and dead methods from the codebase.

#### 7.2 Prerequisites
Phases 1–6 complete.

#### 7.3 Files Affected
- [`apps/server/src/payments/credit.guard.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.ts) *(DELETE)*
- [`apps/server/src/payments/credit-refund.interceptor.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-refund.interceptor.ts) *(DELETE)*
- [`apps/server/src/payments/credit-cost.decorator.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-cost.decorator.ts) *(DELETE)*
- [`apps/server/src/payments/credit.guard.spec.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit.guard.spec.ts) *(DELETE)*
- [`apps/server/src/payments/credit-refund.interceptor.spec.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/credit-refund.interceptor.spec.ts) *(DELETE)*
- [`apps/server/src/payments/payments.module.ts`](file:///Users/kashifrezwi/Developer/code-review-agent/apps/server/src/payments/payments.module.ts)

#### 7.4 Detailed Instructions
1. Remove `CreditGuard`, `CreditRefundInterceptor`, and `CreditCost` decorator files.
2. Remove their imports and providers from `PaymentsModule`.
3. Verify no lingering imports exist across `review.module.ts`, `history.module.ts`, or any test files.

#### 7.5 Testing & Validation
- Run `pnpm type-check` across monorepo.
- Run `pnpm lint` to ensure zero dead imports.

#### 7.6 Completion Criteria
All obsolete credit guard/interceptor code is cleanly deleted with zero orphaned references.

---

### Phase 8: End-to-End Verification, Monorepo Lint & Production Sign-off

#### 8.1 Objective
Perform full monorepo verification according to the repository verification loop in [`AGENTS.md`](file:///Users/kashifrezwi/Developer/code-review-agent/AGENTS.md).

#### 8.2 Execution Steps
1. `pnpm build:packages`
2. `pnpm type-check`
3. `pnpm --filter server test`
4. `pnpm --filter client test`
5. `pnpm lint`
6. `pnpm build`

#### 8.3 Production Readiness Checklist
- [ ] All 14 audit findings (`RZC-001` through `RZC-014`) resolved.
- [ ] Invariants `INV-01` through `INV-10` enforced and tested.
- [ ] Zero circular module dependencies.
- [ ] Zero dead code in payments/billing subsystem.
- [ ] Client wallet state perfectly synchronized across all pages.
- [ ] Build, type-check, tests, and lint all exit 0.
