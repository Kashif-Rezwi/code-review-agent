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
| 3. Server Unit Tests | `pnpm --filter server test` | **SUCCESS** (30/30 suites passed, 134/134 tests passed) |
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
