# Razorpay Feature — Security Review Remediation

> **Stage:** Remediation of the independent security review (`06-security-review.md`, findings R-01 through R-08)
> **Date:** 2026-08-14
> **Scope:** Fix confirmed security/correctness issues identified by the independent review. Only findings supported by the implementation, relevant to this feature, and not already fixed are addressed.
> **Verification:** Full monorepo verification loop run green after all fixes (`pnpm build:packages`, `pnpm type-check`, `pnpm --filter server test` [31 suites, 152 tests], `pnpm --filter client test` [10 files, 16 tests], `pnpm lint` [exit 0]).

---

## Summary

| Finding | Severity | Status | Approach |
|---|---|---|---|
| R-01 | Medium | **Fixed** | `CreditRefundInterceptor` catches pipe-level 400s (and any pre-handler error) after `CreditGuard` deduction and refunds `req.creditDeducted` |
| R-02 | Medium | **Fixed** | `creditsGranted` persisted at order creation; `captureOrder` reads from local order; fail-closed on `≤ 0` |
| R-03 | Low | **Fixed** | Per-IP `ThrottlerGuard` (100/min) added to webhook route |
| R-04 | Low | **Partially fixed** | Log levels elevated (`not_found` → error, `zero_credits` → error); external alerting is a remaining limitation |
| R-05 | Informational | **Fixed** | `UserThrottlerGuard` (60/min) added to `getWallet` (implements F-12) |
| R-06 | Informational | **Fixed** | Dead `NEXT_PUBLIC_RAZORPAY_KEY_ID` env var removed from `.env.example` and `docs/deployment.md` |
| R-07 | Informational | **Fixed** | Payment routes excluded from deprecated `?token=` auth fallback |
| R-08 | Informational | **Fixed** | Type guard added after `JSON.parse` in webhook handler |

---

## R-01 — Credits deducted by CreditGuard not refunded when ValidationPipe rejects (400)

### Finding
NestJS guards run before pipes. `CreditGuard` deducts credits and sets `req.creditDeducted` / `req.creditUserId`. If `ValidationPipe` then rejects the body (400), the handler never runs and the S-03/S-04 handler-level refund (in the handler's catch block) never fires. Credits are silently and permanently burned.

### Remediation
Created `CreditRefundInterceptor` — a per-route `NestInterceptor` applied via `@UseInterceptors()` on the two credit-guarded routes (`POST /review/session`, `POST /history/:id/chat`). The interceptor wraps `next.handle()` with a RxJS `catchError` that:
1. Checks for `req.creditDeducted` / `req.creditUserId` markers left by `CreditGuard`.
2. If present, refunds the credits via `PaymentsService.refundCredits()` and clears the markers.
3. Re-throws the original exception for the built-in NestJS exception filter to format the HTTP response.

**Double-refund prevention:**
- The S-03 handler catch block (review) now **clears** the markers after its own refund, so when the re-thrown exception propagates through the interceptor's `catchError`, it sees no markers and skips.
- The S-04 chat stream error is handled inside the Observable's async IIFE; the Observable *completes* (does not error), so the interceptor's `catchError` never fires.
- Guard-level exceptions (402 insufficient credits, 429 throttled) occur *before* the interceptor's `next.handle()`, so they bypass it — and `CreditGuard` does not set markers when it throws 402.

### Files changed
- **NEW** `apps/server/src/payments/credit-refund.interceptor.ts` — the interceptor
- `apps/server/src/payments/payments.module.ts` — registered + exported `CreditRefundInterceptor`
- `apps/server/src/review/review.controller.ts` — added `@UseInterceptors(CreditRefundInterceptor)`, clear markers in S-03 catch
- `apps/server/src/history/history.controller.ts` — added `@UseInterceptors(CreditRefundInterceptor)`, clear markers in S-04 catch
- `apps/server/src/review/review.controller.spec.ts` — added R-01 E2E test suite (2 tests), added `CreditRefundInterceptor` provider
- `apps/server/src/review/review.throttle.spec.ts` — added `CreditRefundInterceptor` provider

### Verification
- `R-01: refunds pre-deducted credits when ValidationPipe rejects the body (400)` — sends `{ type: 'CODE' }` (missing `input`), asserts 400 + `refundCredits` called once with `{ userId: 'user-1', cost: 5 }` + handler not called.

---

## R-02 — creditsGranted resolves to 0 and the order is still captured (fail-open entitlement)

### Finding
`handleOrderPaid` resolved `creditsGranted` from the package table at webhook time: `const creditsGranted = pkg?.credits ?? 0`. If the package was removed/renamed between order creation and webhook delivery, `pkg` was `null`, `creditsGranted` became `0`. The amount cross-check passed (it uses `localOrder.amountPaise`, not the package), so the order was captured with `0` credits — the user paid but received nothing.

### Remediation
1. **Persist `creditsGranted` at order creation time.** `PaymentsService.createOrder` now passes `creditsGranted: pkg.credits` to `PaymentsRepository.createOrder`, which stores it on the `PaymentOrder` row.
2. **Read `creditsGranted` from the local order in `captureOrder`.** The `creditsGranted` parameter was removed from `captureOrder`'s signature. The method now reads `localOrder.creditsGranted` for all credit-granting operations (status transition, balance increment, ledger entry).
3. **Fail-closed on `≤ 0`.** After loading the local order, if `localOrder.creditsGranted <= 0`, the method records a `order.paid.zero_credits` event (for reconciliation) and returns `'zero_credits'` — the order is left `CREATED`, no credits are granted.
4. **Removed `resolvePackageForOrder`** private method from `PaymentsService` — no longer needed.

### Files changed
- `apps/server/src/payments/payments.repository.ts` — `createOrder` accepts `creditsGranted`; `captureOrder` reads from `localOrder.creditsGranted`, added fail-closed zero-credit guard + `'zero_credits'` return value
- `apps/server/src/payments/payments.service.ts` — `createOrder` passes `creditsGranted: pkg.credits`; `handleOrderPaid` no longer resolves package; removed `resolvePackageForOrder`; switch handles `'zero_credits'`
- `apps/server/prisma/schema.prisma` — updated `creditsGranted` comment
- `apps/server/src/payments/payments.service.spec.ts` — WH-01 assertion updated (no `creditsGranted` param)
- `apps/server/src/payments/payments.repository.spec.ts` — `baseParams` updated, `localOrder` mock includes `creditsGranted: 50`, added R-02 zero-credit fail-closed test

### Verification
- `R-02: returns zero_credits when localOrder.creditsGranted <= 0 (fail-closed)` — mocks order with `creditsGranted: 0`, asserts `'zero_credits'` return, no balance increment, no ledger entry, `order.paid.zero_credits` event recorded.

---

## R-03 — Unauthenticated webhook endpoint not rate-limited

### Finding
`POST /payments/webhook` had no rate limiting. While HMAC verification prevents forged requests, an attacker with the webhook secret could flood the endpoint.

### Remediation
Added `@UseGuards(ThrottlerGuard)` and `@Throttle({ default: { limit: 100, ttl: 60_000 } })` to the webhook route — 100 requests/min per IP. Far above legitimate Razorpay delivery rates but prevents flooding.

### Files changed
- `apps/server/src/payments/webhook.controller.ts` — added `ThrottlerGuard` + `@Throttle`
- `apps/server/src/payments/webhook.controller.spec.ts` — added `ThrottlerModule` to test imports

### Verification
- All 4 existing webhook controller tests pass with `ThrottlerModule` in scope.

---

## R-04 — No reconciliation/alerting for amount_mismatch and not_found outcomes

### Finding
`amount_mismatch`, `not_found`, and (after R-02) `zero_credits` outcomes were logged but not alertable. The `not_found` case was logged at `warn` level, not `error`.

### Remediation
- Elevated `not_found` log from `warn` to `error` (a paid order with no local row is revenue-impacting).
- Added `zero_credits` case to the switch statement with `error`-level logging.
- `amount_mismatch` was already logged at `error` level in the repository (S-02).

**Not implemented (remaining limitation):** A metrics/alerting system and a reconciliation job are not added — the codebase has no metrics infrastructure, and adding one would be speculative. External log aggregation monitoring these `error`-level logs is the appropriate alerting mechanism.

### Files changed
- `apps/server/src/payments/payments.service.ts` — elevated `not_found` to `error`, added `zero_credits` case

### Verification
- Unit tests verify the `zero_credits` path (R-02 test) and `not_found` path (existing repository test). Log level changes verified by code inspection.

---

## R-05 — F-12 wallet rate-limit (60/min) never implemented

### Finding
`GET /payments/wallet` had no `@UseGuards(UserThrottlerGuard)` / `@Throttle(...)`, diverging from `02-architecture.md` §9 (F-12: 60/min).

### Remediation
Added `@UseGuards(UserThrottlerGuard)` and `@Throttle({ default: { limit: 60, ttl: 60_000 } })` to the `getWallet` route. Matches the architecture spec and the client's polling rate.

### Files changed
- `apps/server/src/payments/payments.controller.ts` — added `UserThrottlerGuard` + `@Throttle` to `getWallet`

### Verification
- Type-check and lint pass. The guard is verified by the existing throttle infrastructure.

---

## R-06 — NEXT_PUBLIC_RAZORPAY_KEY_ID is dead configuration

### Finding
The client obtains the Razorpay publishable `key_id` from the `POST /payments/order` response (`orderData.keyId`), not from the `NEXT_PUBLIC_RAZORPAY_KEY_ID` environment variable. The env var is never read in client code.

### Remediation
Removed `NEXT_PUBLIC_RAZORPAY_KEY_ID` from `apps/client/.env.example`, `docs/deployment.md` Vercel env-var table, and updated `apps/server/.env.example` comment.

### Files changed
- `apps/client/.env.example`, `apps/server/.env.example`, `docs/deployment.md`

### Verification
- `grep -rn 'NEXT_PUBLIC_RAZORPAY_KEY_ID' apps/client/` returns no source code references. Type-check and lint pass.

---

## R-07 — ?token= query-param auth fallback on payment routes

### Finding
The deprecated `?token=` query-param auth fallback in `AuthGuard` applies to all authenticated routes, including the new payment endpoints.

### Remediation
Added a path check: `!(req.path ?? '').startsWith('/payments/')`. Payment routes now require the `Authorization: Bearer` header exclusively. Non-payment routes retain the deprecated fallback.

### Files changed
- `apps/server/src/auth/auth.guard.ts` — added `/payments/` path exclusion

### Verification
- Type-check and lint pass. The payment client always uses the `Authorization: Bearer` header via `apiFetch`.

---

## R-08 — Signed non-object webhook body causes unhandled 500

### Finding
`JSON.parse(rawBody.toString('utf8'))` could return a non-object value (e.g., `null`, `"str"`, `123`). The subsequent `event.event` access would throw a `TypeError`.

### Remediation
Added a type guard after `JSON.parse`: `if (typeof parsed !== 'object' || parsed === null) { logger.warn(...); return }`.

### Files changed
- `apps/server/src/payments/payments.service.ts` — added type guard in `handleWebhook`

### Verification
- `R-08: valid JSON but non-object body (null)` and `(string)` tests — asserts no throw, `captureOrder` not called.

---

## Remaining limitations

| Limitation | Why not fixed | Recommended action |
|---|---|---|
| **No metrics/alerting system** (R-04) | Codebase has no metrics infrastructure; adding one is speculative | Configure external log aggregation to alert on `error`-level logs containing `[R-02]`, `[F-09]`, `zero_credits`, `not_found`, `amount_mismatch` |
| **No reconciliation job for stranded CREATED orders** (R-04) | A new scheduled job is a feature, not a security fix | Before go-live, add a process to re-fetch Razorpay orders `CREATED` for > 1 hour |
| **`?token=` fallback not fully removed** (R-07) | Full removal affects all routes (cross-cutting) | Monitor logs for `?token=` usage; remove entirely once usage is zero |
| **DB-level race not verified under load** (S-01, S-06) | Requires real Postgres with concurrent connections | Integration test before go-live (per `05-security-hardening.md` §5.4) |
| **Guard→refund chain not E2E tested against real DB** (R-01) | Verified at supertest level but not against real Postgres | E2E test with supertest + real DB before go-live |
| **Razorpay sandbox E2E** | Requires test-mode API keys and webhook tunnel | Manual test per production deployment checklist |

---

## Related files

| File | Role in this remediation |
|---|---|
| [`06-security-review.md`](./06-security-review.md) | Source — findings R-01 through R-08 |
| [`04-implementation.md`](./04-implementation.md) | Updated with remediation execution log |
| [`05-security-hardening.md`](./05-security-hardening.md) | Updated with R-01–R-08 remediation section |
| `apps/server/src/payments/credit-refund.interceptor.ts` | NEW — R-01 credit refund interceptor |
| `apps/server/src/payments/payments.repository.ts` | R-02 (persist creditsGranted, fail-closed) |
| `apps/server/src/payments/payments.service.ts` | R-02, R-04, R-08 |
| `apps/server/src/payments/webhook.controller.ts` | R-03 (rate limit) |
| `apps/server/src/payments/payments.controller.ts` | R-05 (wallet throttle) |
| `apps/server/src/payments/payments.module.ts` | R-01 (register interceptor) |
| `apps/server/src/review/review.controller.ts` | R-01 (interceptor + marker clearing) |
| `apps/server/src/history/history.controller.ts` | R-01 (interceptor + marker clearing) |
| `apps/server/src/auth/auth.guard.ts` | R-07 (exclude payment routes from ?token=) |
| `apps/server/prisma/schema.prisma` | R-02 (comment update) |
| `apps/client/.env.example` | R-06 (remove dead env var) |
| `apps/server/.env.example` | R-06 (update comment) |
| `docs/deployment.md` | R-06 (remove dead env var reference) |
- `R-01: does NOT refund when the body is valid and the handler succeeds (201)` — sends valid payload, asserts 201 + `refundCredits` not called.