# Razorpay Feature — Implementation Execution Log

## Overview

This document records the step-by-step implementation of the Razorpay prepaid credits feature for Code Review Agent based on the specification in `02-architecture.md` and `03-implementation-plan.md`.

All 11 chunks have been fully executed, tested, and verified green against the monorepo verification loop protocol (`pnpm build:packages`, `pnpm type-check`, `pnpm --filter server test`, `pnpm --filter client test`, `pnpm lint`).

---

## Chunk Execution Log

### Chunk 1: Branch Hygiene & Sync
- Merged `main` into `payment-integration`.
- Verified package builds, type-checking, and unit tests baseline green.

### Chunk 2: Prisma Schema & Database Migration
- Added Prisma models: `PaymentOrder`, `PaymentEvent`, `CreditLedger`.
- Added `creditBalance Int @default(0)` to `User` model.
- Created and deployed migration `20260813172114_add_payment_credit_models` to Neon PostgreSQL.
- Generated updated Prisma Client (`v6.19.2`).

### Chunk 3: Server Entry & Environment Setup
- Configured NestJS server entry (`main.ts`) with `{ rawBody: true }` for HMAC signature verification (`req.rawBody` Buffer).
- Updated `apps/server/.env.example` with Razorpay variables (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) and removed Stripe placeholders.
- Updated `apps/client/.env.example` with `NEXT_PUBLIC_RAZORPAY_KEY_ID`.
- Updated `render.yaml` with Razorpay secret declarations (`sync: false`).

### Chunk 4: Shared Types (`@cra/types`)
- Defined Zod schemas: `CreditPackageSchema`, `LedgerEntrySchema`, `WalletResponseSchema`.
- Exported TypeScript types: `CreditPackage`, `LedgerEntry`, `WalletResponse`.
- Built `@cra/types` and verified type checking.

### Chunk 5: Module Skeleton & Policy
- Created `credit-cost.policy.ts` defining `CREDIT_PACKAGES` (50, 200, 500), `CREDIT_COSTS` (CODE=5, PR=10, CHAT=1), `FREE_CREDIT_AMOUNT` (25), and `getReviewCreditCost`.
- Created `CreateOrderDto` with `@IsIn` validation on valid package IDs.
- Implemented `PaymentsRepository` with atomic `$transaction` methods for order capture, order failure, credit deduction (`gte` anti-double-spend guard), credit refund, and free credit grant.
- Registered `PaymentsModule` in `AppModule`.

### Chunk 6: Razorpay SDK Integration & PaymentsService
- Installed `razorpay` npm package in `apps/server`.
- Implemented `PaymentsService` creating Razorpay orders via SDK, handling pending order limits (max 3 pending per user, F-11), and safe error handling (F-10).

### Chunk 7: Webhook Endpoint Implementation
- Implemented `WebhookController` with unauthenticated `@Post('webhook')` route.
- Enforced pre-service guards: maximum payload size check (1 MB, F-03), signature format validation (64 hex chars, F-02), and event ID validation (F-08).
- Implemented HMAC-SHA256 timing-safe signature verification (`crypto.timingSafeEqual`) on `rawBody` Buffer in `PaymentsService` (F-01).
- Implemented event routing for `order.paid` (atomic status-guard CREATED → CAPTURED, amount cross-check F-09, increment user balance, record PURCHASE ledger entry) and `payment.failed` (status-guard CREATED → FAILED).

### Chunk 8: Credit Guard & Integration
- Created `@CreditCost` decorator supporting both static costs and dynamic function resolvers.
- Created `CreditGuard` enforcing prepaid credit deduction before handler execution and safe F-06 type evaluation.
- Applied `CreditGuard` to `ReviewController` (`POST /review/session`), `HistoryController` (`POST /history/:id/chat`).
- Updated `ReviewRepository` and `ReviewService` with `markFailedAndRefund` to issue atomic `CONSUMPTION_REFUND` credit ledger entries whenever a review pipeline fails after pre-deduction (F-05).
- Exported `PaymentsModule` to `ReviewModule` and `HistoryModule`.

### Chunk 9: Free-Credit Grant on Signup
- Updated `UsersService.findOrCreate` to call `grantFreeCredits` (25 free credits) upon user signup.
- Handled duplicate grants and `P2002` errors gracefully (F-15).
- Exported `PaymentsModule` to `UsersModule`.

### Chunk 10: Client Account Page & Razorpay Checkout
- Added `paymentsService` helper to `apps/client/lib/api.ts`.
- Implemented `useWallet` hook for balance, ledger history, credit packages, and post-checkout polling loop (2s interval, max 30 attempts, architecture §8.2).
- Built `apps/client/app/account/page.tsx` displaying wallet balance, package top-up cards with Razorpay Checkout.js popup integration, and transaction history table.
- Added `/account/:path*` to `proxy.ts` auth matcher.
- Updated `AppHeader` with `Account` navigation link and dynamic credit balance badge.

### Chunk 11: Documentation & Verification
- Updated `docs/deployment.md` with Razorpay environment variables and webhook tunnel instructions.
- Updated `docs/data-model.md` with `User.creditBalance`, `PaymentOrder`, `PaymentEvent`, and `CreditLedger` schemas.
- Updated `docs/architecture.md` component map and external dependencies.
- Updated `docker-compose.yml` with local webhook tunnel notes.

---

## Final Verification Results

All verification steps pass cleanly:

| Step | Command | Result |
|---|---|---|
| 1. Build Packages | `pnpm build:packages` | **SUCCESS** (`@cra/types`, `@cra/ai` built) |
| 2. Type Check | `pnpm type-check` | **SUCCESS** (0 errors across all 4 projects) |
| 3. Server Unit Tests | `pnpm --filter server test` | **SUCCESS** (31/31 suites passed, 147/147 tests passed) |
| 4. Client Unit Tests | `pnpm --filter client test` | **SUCCESS** (10/10 suites passed, 16/16 tests passed) |
| 5. Linter | `pnpm lint` | **SUCCESS** (Exit code 0, 0 errors across monorepo) |

---

## Security Audit Safeguards Implemented

- **F-01**: HMAC signature calculated over raw request body as Buffer (`req.rawBody`).
- **F-02**: Signature header validated for length and 64-hex format before `crypto.timingSafeEqual`.
- **F-03**: Webhook body size capped at 1 MB prior to HMAC calculation.
- **F-04**: `balanceAfter` snapshot read directly from DB post-update, never computed in application memory.
- **F-05**: Review failure and credit refund run inside a single `$transaction` (`markFailedAndRefund`).
- **F-06**: CreditGuard evaluates costs strictly; invalid request types throw `BadRequestException` before credit logic.
- **F-08**: `x-razorpay-event-id` enforced as required header with max length bounds.
- **F-09**: Webhook `amount_paid` cross-checked against local order `amountPaise`; mismatch records audit event without granting credits.
- **F-10**: No user PII included in Razorpay order notes; SDK errors sanitised in logs.
- **F-11**: Pending orders capped at maximum 3 per user.
- **F-14**: Status transitions use strict status-guard `updateMany` queries (`where: { status: 'CREATED' }`).
- **F-15**: Signup free credit grant handles idempotency gracefully without throwing exceptions.

---

## Security Hardening Pass (2026-08-14)

A focused security-hardening pass was performed on the implemented payment-critical paths. Full details are in [`05-security-hardening.md`](./05-security-hardening.md). The following code changes were made:

### Database migration: credit ledger unique indexes

- **New migration**: `20260814000000_add_credit_ledger_unique_indexes`
- Added partial unique index on `CreditLedger(userId, type) WHERE type = 'FREE_GRANT'` — enforces at-most-one free credit grant per user at the DB level (S-01). The application-level `findFirst` check in `grantFreeCredits` was a TOCTOU race under Read Committed isolation; concurrent signup requests could both pass the check and double-grant.
- Added partial unique index on `CreditLedger(reviewId, type) WHERE type = 'CONSUMPTION_REFUND' AND reviewId IS NOT NULL` — defense-in-depth against double-refund for the same review (S-06). The status-guard in `markFailedAndRefund` provides the primary protection; the DB constraint is belt-and-suspenders.

### `payments.repository.ts` — fail-closed amount check + currency cross-check

- **S-02**: Changed `captureOrder` amount cross-check from fail-open (`amountPaidPaise !== null && ...`) to fail-closed (`amountPaidPaise === null || ...`). A missing `amount_paid` in the webhook payload now results in `amount_mismatch` (no credits granted) instead of silently skipping the check.
- **S-05**: Added `currency` parameter to `captureOrder` and a currency cross-check (`currency !== null && localOrder.currency !== currency`). When the webhook payload includes a currency that doesn't match the local order, credits are not granted.
- **S-01**: Added `.catch` on `grantFreeCredits`'s `$transaction` to handle P2002 (unique constraint violation from the new partial index). Returns `false` (already granted) instead of throwing.
- Added `refundCredits` method — a standalone-transaction refund for guard-level credit recovery (S-03/S-04).

### `payments.service.ts` — currency extraction + refund method

- Extracts `currency` from `payload.order.entity.currency` in `handleOrderPaid` and passes it to `captureOrder`.
- Added `refundCredits` method that delegates to the repository.

### `review.controller.ts` — handler-failure credit refund (S-03)

- Injected `PaymentsService` into `ReviewController`.
- Wrapped `createSession` handler in a try/catch that refunds pre-deducted credits (`req.creditDeducted`) if the handler throws synchronously (e.g. DB error during review creation). The original exception is re-thrown after the refund.

### `history.controller.ts` — chat-stream-failure credit refund (S-04)

- Injected `PaymentsService` into `HistoryController`.
- Added a `refundCredits` call in the chat Observable's catch block. If the AI stream errors (e.g. provider outage), pre-deducted chat credits are refunded.

### `review.repository.ts` — markFailedAndRefund P2002 catch (S-06)

- Added `.catch` on `markFailedAndRefund`'s `$transaction` to handle P2002 from the new `CONSUMPTION_REFUND` unique index. Returns `false` (refund already exists) instead of throwing.

### `payments.module.ts` — circular dependency fix (runtime)

- Added `forwardRef(() => AuthModule)` to break the 3-way circular module dependency: `AuthModule → UsersModule → PaymentsModule → AuthModule`.
- **Why it existed:** `AuthModule` imports `UsersModule` (AuthService needs UsersService), `UsersModule` imports `PaymentsModule` (UsersService needs PaymentsService for free credit grant), and `PaymentsModule` imports `AuthModule` (PaymentsController needs AuthGuard). In the compiled CommonJS output (swc), this caused a `ReferenceError: Cannot access 'AuthModule' before initialization` at module load time.
- **Why tests passed but Docker failed:** Jest (ts-jest/swc) resolves modules differently from Node.js CommonJS runtime. TypeScript's type-checker doesn't execute module loading. The error only manifested in the compiled `dist/` output.
- **Verified by:** `node -e "require('./dist/app.module.js')"` — loads without error; NestJS bootstrap confirms all modules (`UsersModule`, `AuthModule`, `PaymentsModule`) initialize successfully.

### Tests added

- **`payments.repository.spec.ts`** (new file, 11 tests): fail-closed amount check, currency mismatch, successful capture, already-captured, not-found, null currency, P2002 race protection, non-P2002 rethrow, findFirst fast path, guard-level refund.
- **`payments.service.spec.ts`** (+1 test): currency extraction from webhook payload.
- **`review.controller.spec.ts`** (+1 test): handler-failure propagation (S-03).
- Updated `review.controller.spec.ts` and `review.throttle.spec.ts` to provide `PaymentsService` mock.

---

## Security Review Remediation (R-01 through R-08)

> **Date:** 2026-08-14
> **Source:** Independent security review ([`06-security-review.md`](./06-security-review.md)), findings R-01 through R-08.
> **Full record:** [`07-remediation.md`](./07-remediation.md)

### Changes applied

- **R-01 (Medium):** Created `CreditRefundInterceptor` (`apps/server/src/payments/credit-refund.interceptor.ts`) — catches pipe-level 400s and any pre-handler error after `CreditGuard` deduction, refunds `req.creditDeducted` via RxJS `catchError`. Applied via `@UseInterceptors()` on `POST /review/session` and `POST /history/:id/chat`. Handler catch blocks (S-03/S-04) now clear `creditDeducted`/`creditUserId` markers to prevent double-refund. Registered in `PaymentsModule`.
- **R-02 (Medium):** `creditsGranted` now persisted at order creation (`PaymentsService.createOrder` → `PaymentsRepository.createOrder`). `captureOrder` reads `creditsGranted` from `localOrder` instead of re-resolving the package at webhook time. Fail-closed: `≤ 0` returns `'zero_credits'`, records `order.paid.zero_credits` event, leaves order `CREATED`. Removed `resolvePackageForOrder` from `PaymentsService`. Updated `schema.prisma` comment.
- **R-03 (Low):** Added `@UseGuards(ThrottlerGuard)` + `@Throttle({ default: { limit: 100, ttl: 60_000 } })` to `POST /payments/webhook` (`webhook.controller.ts`). Updated `webhook.controller.spec.ts` to import `ThrottlerModule`.
- **R-04 (Low):** Elevated `not_found` log to `error` level. Added `zero_credits` case with `error`-level logging in `handleOrderPaid` switch. External alerting = remaining limitation.
- **R-05 (Informational):** Added `@UseGuards(UserThrottlerGuard)` + `@Throttle({ default: { limit: 60, ttl: 60_000 } })` to `GET /payments/wallet` (`payments.controller.ts`) — implements F-12.
- **R-06 (Informational):** Removed dead `NEXT_PUBLIC_RAZORPAY_KEY_ID` from `apps/client/.env.example` and `docs/deployment.md`. Updated `apps/server/.env.example` comment.
- **R-07 (Informational):** Excluded `/payments/` routes from the deprecated `?token=` auth fallback in `auth.guard.ts`.
- **R-08 (Informational):** Added type guard (`typeof parsed !== 'object' || parsed === null`) after `JSON.parse` in `handleWebhook` (`payments.service.ts`).

### Tests added

- **`review.controller.spec.ts`** (+2 tests): R-01 pipe-level 400 credit refund, R-01 valid-201 no-refund.
- **`payments.service.spec.ts`** (+2 tests): R-08 non-object JSON body (null), R-08 non-object JSON body (string).
- **`payments.repository.spec.ts`** (+1 test): R-02 zero-credit fail-closed.
- Updated `review.controller.spec.ts`, `review.throttle.spec.ts`, `webhook.controller.spec.ts` for new providers/imports.

### Verification

All green: `pnpm build:packages` ✓, `pnpm type-check` ✓ (4 projects, 0 errors), `pnpm --filter server test` ✓ (31 suites, 152 tests), `pnpm --filter client test` ✓ (10 files, 16 tests), `pnpm lint` ✓ (exit 0).
