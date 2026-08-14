# Razorpay Payment Integration — Independent Security Review

> **Stage:** Independent security review of the implemented code
> **Date:** 2026-08-14
> **Reviewer stance:** Independent — this document was produced by re-reading the source code from first principles, *not* by re-stating the prior design (`01-audit.md` F-01–F-16) or hardening (`05-security-hardening.md` S-01–S-06) passes. Findings that overlap those passes are cross-referenced, not duplicated.
> **Scope:** Payment-critical paths only — payment integrity, signature/webhook security, webhooks (idempotency, replay, retries, races), authentication/authorization, secrets, state consistency, and operational correctness.
> **Method:** Read all five prerequisite documents, then read every source file in `apps/server/src/payments/`, the credit-guard touchpoints (`review.controller.ts`, `history.controller.ts`), the refund paths (`review.repository.ts`, `review.service.ts`), the client checkout flow (`account/page.tsx`, `use-wallet.ts`, `api.ts`), the Prisma schema + both payment migrations, `main.ts`, `app.module.ts`, `auth.guard.ts`, and `throttle/user-throttler.guard.ts`.
> **No application code was modified.** This document is the authoritative security-review record.

---

## 1. Scope and methodology

Every finding is grounded in a specific file and line range in the *implemented* code, not in a design document. For each finding the document records: severity, exact location, vulnerable behavior, attack/failure scenario, why it matters, and concrete remediation.

Prior findings are not restated here. Two earlier passes exist and remain authoritative for their own scope:

| Prior pass | Document | Findings |
|---|---|---|
| Design-phase (pre-code) | `01-audit.md` | F-01 … F-16 |
| Hardening pass (post-code) | `05-security-hardening.md` | S-01 … S-06 |

This review adds findings **R-01 … R-08**. §5 reconciles all three sets.

---

## 2. Threat model (verified against code)

### 2.1 Trust boundaries

```
 UNTRUSTED                                        TRUSTED
 ────────                                         ────────
 Browser / client code              │  NestJS API server
  - GitHub Bearer token             │   - AuthGuard resolves token → req.user
  - Drives Razorpay Checkout.js     │   - All credit mutations server-side
  - Observes wallet by polling      │   - Amount/currency from CREDIT_PACKAGES
                                    │   - Secrets never leave server
 Razorpay servers (webhook)         │
  - Unauthenticated HTTP POST       │  Razorpay servers (API)
  - Verified by HMAC-SHA256         │   - Called server-side over HTTPS
    before any processing           │   - key_id/key_secret credentials
```

### 2.2 Attacker classes

| Class | Capability | Notes |
|---|---|---|
| Authenticated user — honest | Own token, own balance | Primary user of the flow |
| Authenticated user — malicious | Own token; crafts requests to gain credits / avoid payment | Cannot touch other users' rows (mutations keyed on `req.user.userId` or a server-side `localOrder.userId` lookup) |
| Unauthenticated internet host | POSTs to `/payments/webhook` | Blocked by HMAC unless webhook secret is known |
| Attacker with webhook secret | Can forge valid `order.paid` events | Critical asset — see §2.3 |
| MITM between Razorpay and server | Can observe/replay webhooks | HTTPS + HMAC + idempotency keys |

### 2.3 Assets

| Asset | Sensitivity | Consequence if compromised |
|---|---|---|
| `RAZORPAY_KEY_SECRET` | Critical | Orders created/fetched on behalf of merchant |
| `RAZORPAY_WEBHOOK_SECRET` | Critical | Attacker manufactures webhook events → unlimited credits |
| `User.creditBalance` | High | Credits stolen/manufactured → revenue loss |
| `CreditLedger` | High | Audit trail corrupted → undetectable fraud |
| `PaymentOrder` rows | High | Order ownership/status manipulated |

---

## 3. Controls verified correct

These properties were checked against code and found sound. They are recorded so the review is auditable and so future changes do not regress them.

| # | Control | Evidence (file:lines) |
|---|---|---|
| C-1 | **Client cannot set price/amount/plan.** Order amount+currency come only from `CREDIT_PACKAGES` server-side; the DTO whitelists `packageId`. | `payments.service.ts:45-69`, `dto/create-order.dto.ts:7-9` |
| C-2 | **`userId` never trusted from the body.** `createOrder`/`getWallet` use `req.user!.userId` set by `AuthGuard`. | `payments.controller.ts:27-36`, `auth.guard.ts:44-53` |
| C-3 | **Webhook HMAC over raw bytes, timing-safe.** HMAC-SHA256 over `req.rawBody` Buffer, `crypto.timingSafeEqual`, 64-hex format enforced before compare. | `payments.service.ts:105-121`, `webhook.controller.ts:43-45` |
| C-4 | **Webhook idempotency (two layers).** `razorpayEventId` unique constraint + status-guard `updateMany WHERE status='CREATED'`. | `payments.repository.ts:54,91-95,148-151`, migration `PaymentEvent_razorpayEventId_key` |
| C-5 | **Amount + currency cross-check, fail-closed on missing amount.** | `payments.repository.ts:67-88` |
| C-6 | **Atomic credit mutations; `balanceAfter` read from DB, never computed.** | `payments.repository.ts:51-122,193-217,236-256,263-299` |
| C-7 | **Order→user ownership resolved server-side at capture time** (`localOrder.userId`), not from the webhook payload. | `payments.repository.ts:64,98-101` |
| C-8 | **Secrets contained.** `RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET` never leave the server; SDK errors sanitised to `.message` (no headers). | `payments.service.ts:33-37,70-74` |
| C-9 | **Free-credit grant idempotent at DB level.** Partial unique index + P2002 catch. | migration `20260814000000_…`, `payments.repository.ts:263-299` |
| C-10 | **Refund double-spend guarded.** `CONSUMPTION_REFUND` unique (reviewId,type) + status guard. | migration `20260814000000_…`, `review.repository.ts:68-121` |
| C-11 | **Failure paths keep review/refund atomic** (F-05): `markFailedAndRefund` single `$transaction`. | `review.repository.ts:68-114`, `review.service.ts:135-143` |

---

## 4. Findings

### R-01 — MEDIUM — Credits deducted by `CreditGuard` are not refunded when `ValidationPipe` rejects the body (400)

1. **Severity:** Medium
2. **Exact location:**
   - `apps/server/src/payments/credit.guard.ts:72-77` (deduction inside `canActivate`), `:88-89` (records `req.creditDeducted`/`req.creditUserId`)
   - `apps/server/src/review/review.controller.ts:41-61` (refund only inside the handler's try/catch)
   - `apps/server/src/history/history.controller.ts:60-90` (refund only inside the chat stream's catch)
   - `apps/server/src/main.ts:8` (global `ValidationPipe({ whitelist: true })`)
3. **Vulnerable behavior:** NestJS executes guards **before** pipes. `CreditGuard` decrements `User.creditBalance`, then the global `ValidationPipe` validates the `@Body()` DTO. When validation fails it throws `BadRequestException` (400) *before* the handler body executes — so the refund logic added in S-03/S-04 (which lives inside the handler's try/catch or the stream's catch block) never runs. The deducted credits are lost.
4. **Attack/failure scenario:** An authenticated user POSTs `/review/session` with `{"type":"CODE"}` (missing `input`) or `{"type":"CODE","input":""}`, or POSTs `/history/:id/chat` with `{"message":""}`. Each request returns 400 but permanently burns 5 (CODE) / 1 (chat) credits. This is triggerable accidentally (a malformed client payload) or deliberately, and requires no special privilege.
5. **Why it matters:** It violates the core invariant "every credit deduction maps to an entitlement *or* a refund." It is a silent, irreversible credit (money) loss on a normal edge path, and it is not covered by S-03/S-04, which only handle *handler-level* failures, not *pipe-level* validation failures.
6. **Concrete remediation:** Refund `req.creditDeducted`/`req.creditUserId` from a global `ExceptionFilter` when a `BadRequestException` originates from `ValidationPipe` *after* `CreditGuard` ran (the request object carries the marker). Alternatively, restructure the cost-charging into an interceptor that runs *after* pipes, so validation always precedes deduction. Add a supertest/E2E test asserting `POST /review/session` with an invalid body does **not** change the balance.

### R-02 — MEDIUM — `creditsGranted` resolves to `0` and the order is still captured (fail-open entitlement)

1. **Severity:** Medium
2. **Exact location:**
   - `apps/server/src/payments/payments.service.ts:163-164` — `const pkg = await this.resolvePackageForOrder(razorpayOrderId)` … `const creditsGranted = pkg?.credits ?? 0`
   - `apps/server/src/payments/payments.repository.ts:90-121` — `captureOrder` marks the order `CAPTURED` and increments the balance by `creditsGranted` with no zero/positive guard
3. **Vulnerable behavior:** If `CREDIT_PACKAGES[localOrder.packageId]` is undefined (a package removed or renamed between order creation and webhook delivery), `creditsGranted` becomes `0`. The amount cross-check still passes — `amountPaise` is a stored field on the local order, not derived from the package table — so `captureOrder` proceeds to mark the order `CAPTURED`, increment `User.creditBalance` by `0`, and append a "Purchased 0 credits" ledger row. The user is charged, the order is terminal, and zero credits are granted, with no alert.
4. **Attack/failure scenario:** A package key is edited in `credit-cost.policy.ts` (e.g. `'50'` → `'50cr'`) after orders were created but before their webhooks arrive, or a `packageId` row is otherwise corrupted. Every affected order that later receives a legitimate `order.paid` webhook is captured with zero credits.
5. **Why it matters:** This is the canonical "payment succeeds but entitlement fails" state-consistency failure. It contradicts the fail-closed posture used for the amount cross-check (S-02) and produces a misleading audit trail (a `PURCHASE` ledger entry of 0). The hardening pass flagged the *price-change* variant of this (grants differ when package definitions change) but not the *zero-credit capture with no fail-closed guard* path.
6. **Concrete remediation:** Persist `creditsGranted` on `PaymentOrder` at creation time and read it in `captureOrder` instead of re-resolving the package at webhook time. Additionally, fail closed: if the resolved package is `null` or `creditsGranted <= 0`, record a `order.paid.amount_mismatch`-style event and leave the order `CREATED` for reconciliation instead of capturing it.

### R-03 — LOW — Unauthenticated webhook endpoint is not rate-limited

1. **Severity:** Low
2. **Exact location:**
   - `apps/server/src/payments/webhook.controller.ts:23-54` — no `@UseGuards(…)` / `@Throttle(…)` on the route or class
   - `apps/server/src/app.module.ts:20-23` — `ThrottlerModule.forRoot` default throttler only applies where a throttler guard is used (none on this controller)
3. **Vulnerable behavior:** `/payments/webhook` accepts requests from any host with no per-IP or per-user throttle. Each request performs HMAC-SHA256 over the raw body (up to the Express default ~100 KB) plus header regex checks, before being rejected with 401 for a bad signature.
4. **Attack/failure scenario:** An attacker floods the endpoint with large bodies and random signatures to consume CPU (unbounded unauthenticated HMAC computation) and generate 401 noise. Not amplified, but there is no ceiling on request rate.
5. **Why it matters:** The webhook is the only unauthenticated, externally-reachable endpoint in the module; leaving it unthrottled is an avoidable DoS surface on a payment-critical path.
6. **Concrete remediation:** Apply a per-IP `ThrottlerGuard` (or a reverse-proxy/edge rate limit) to the webhook route. A modest limit (e.g. 100 req/min per IP) is far above legitimate Razorpay delivery rates and bounds the compute an attacker can force.

### R-04 — LOW — No reconciliation/alerting for `amount_mismatch` and `not_found` webhook outcomes

1. **Severity:** Low
2. **Exact location:**
   - `apps/server/src/payments/payments.service.ts:187-192` — `not_found` and `amount_mismatch` cases only log
   - `apps/server/src/payments/payments.repository.ts:65,72-88` — `not_found` return and `amount_mismatch` recording (order left `CREATED`)
3. **Vulnerable behavior:** A legitimately paid order whose webhook hits an amount/currency mismatch — or references an order with no local row — is logged and (for mismatch) recorded as a `PaymentEvent`, but the `PaymentOrder` remains `CREATED` forever. No credit is granted, no alert fires, and there is no reconciliation job to re-examine the order.
4. **Attack/failure scenario:** Razorpay-side amount drift, a misconfigured environment, or a schema/config change causes `order.paid` events to fail the cross-check. Users pay, receive nothing, and the failure is only visible to someone actively reading server logs.
5. **Why it matters:** This is the operational side of "payment succeeds but entitlement fails." The system is correct in *not* granting credits, but silent: the business loses visibility into a revenue-impacting failure, and affected orders are never recovered.
6. **Concrete remediation:** Emit an alert/metric on `amount_mismatch`, `not_found`, and (after R-02) `creditsGranted == 0`. Optionally add a reconciliation job that re-fetches the Razorpay order (server-side, authenticated) for stranded `CREATED` orders and either captures or flags them.

### R-05 — INFORMATIONAL — F-12 wallet rate-limit (60/min) never implemented

1. **Severity:** Informational
2. **Exact location:** `apps/server/src/payments/payments.controller.ts:33-36` — `getWallet` has no `@UseGuards(UserThrottlerGuard)` / `@Throttle(...)`, diverging from `02-architecture.md` §7.1 and plan F-12 (60/min).
3. **Vulnerable behavior:** `GET /payments/wallet` is authenticated (class-level `AuthGuard`) but unthrottled, so a user can poll their own wallet without limit.
4. **Attack/failure scenario:** A user (or a leaked token) polls the wallet endpoint at high frequency. Read-only and scoped to the caller's own data, so impact is limited to server load.
5. **Why it matters:** It is a documented-control divergence rather than an exploitable flaw; the client's own polling (every 2 s, 30 attempts) already approaches the intended 60/min ceiling, so the missing limit is low-risk but should be reconciled.
6. **Concrete remediation:** Either add the F-12 throttle guard, or update the architecture doc to reflect the intentional omission.

### R-06 — INFORMATIONAL — `NEXT_PUBLIC_RAZORPAY_KEY_ID` is dead configuration

1. **Severity:** Informational
2. **Exact location:** `apps/client/app/account/page.tsx:52-60` uses `orderData.keyId` returned by the server; `NEXT_PUBLIC_RAZORPAY_KEY_ID` (declared in `apps/client/.env.example`) is never read in client code.
3. **Vulnerable behavior:** The client obtains the Razorpay publishable `key_id` from the `POST /payments/order` response rather than the `NEXT_PUBLIC_RAZORPAY_KEY_ID` environment variable. The env var is now redundant.
4. **Attack/failure scenario:** None directly — `key_id` is publishable by design (C-8/§2.3 list the *secret* as critical, not the key id). The risk is config drift: an operator setting only `NEXT_PUBLIC_RAZORPAY_KEY_ID` would see no effect, and two sources of truth for the same value invite mistakes.
5. **Why it matters:** Not a secret-exposure or integrity issue, but worth resolving to keep deployment documentation truthful.
6. **Concrete remediation:** Either remove `NEXT_PUBLIC_RAZORPAY_KEY_ID` and rely solely on the server-returned `keyId`, or use the env var client-side and stop returning `keyId` from `createOrder` — and update `.env.example` / `docs/deployment.md` to match.

### R-07 — INFORMATIONAL — Paid endpoints inherit the deprecated `?token=` query-param auth fallback

1. **Severity:** Informational
2. **Exact location:** `apps/server/src/auth/auth.guard.ts:33-38` — accepts `req.query.token` as a fallback credential, which also authenticates `/payments/order` and `/payments/wallet`.
3. **Vulnerable behavior:** A GitHub token passed as a query parameter is accepted, leaking into proxy/access logs, browser history, and `Referer` headers.
4. **Attack/failure scenario:** A token used with `?token=` is logged by any intermediate proxy and can be replayed by anyone who can read those logs.
5. **Why it matters:** Pre-existing behavior, not introduced by the Razorpay feature, but the new paid endpoints now expose it. Payment operations should not be reachable through a token-transmission method the codebase itself calls "deprecated."
6. **Concrete remediation:** Remove the `?token=` fallback before go-live (the code comment already marks it a removal candidate), or at minimum exclude payment routes from it.

### R-08 — INFORMATIONAL — Signed non-object webhook body causes an unhandled 500

1. **Severity:** Informational
2. **Exact location:** `apps/server/src/payments/payments.service.ts:124-130` — `JSON.parse` result is cast and `event.event` is read without a type guard.
3. **Vulnerable behavior:** A body that is valid JSON but not an object (e.g. the literal `null`, `"str"`, or `123`) parses successfully, then `event.event` throws a `TypeError`, which propagates as a 500.
4. **Attack/failure scenario:** Only reachable with a valid HMAC signature (Razorpay-only), and Razorpay always delivers object payloads — so the realistic trigger is a Razorpay-side anomaly, not an attacker.
5. **Why it matters:** Low-severity robustness: a 500 causes Razorpay to retry the delivery unnecessarily.
6. **Concrete remediation:** Guard the parsed value (e.g. `typeof event === 'object' && event !== null`) and return a `BadRequestException` or log-and-return instead of letting the TypeError propagate.

---

## 5. Cross-reference with prior findings

| Finding | Severity | Status (this review) | Notes |
|---|---|---|---|
| F-01 … F-16 (design) | — | Verified implemented (see `05-security-hardening.md` §3) | F-12 (wallet 60/min) is **not** implemented → R-05 |
| S-01 free-grant TOCTOU | High | Fixed + verified (partial unique index) | Confirmed at `payments.repository.ts:263-299` |
| S-02 amount fail-open | Medium | Fixed + verified (fail-closed) | Confirmed at `payments.repository.ts:70` |
| S-03 review handler refund | Medium | Fixed | **Gap remains for pipe-level 400s** → R-01 |
| S-04 chat stream refund | Medium | Fixed | **Gap remains for pipe-level 400s** → R-01 |
| S-05 currency cross-check | — | Fixed | Fail-open on *missing* currency retained by design (documented §4) |
| S-06 refund unique index | Low | Fixed + verified | — |

R-02 partially overlaps the `05-security-hardening.md` §6 "creditsGranted divergence" remaining-risk row, but that row only considered *price* changes; R-02 identifies the distinct *zero-credit capture with no fail-closed guard* path (package removed → `?? 0` → still `CAPTURED`).

---

## 6. Summary

**No Critical or High findings.** Payment integrity (client-set price, order/payment mismatch, unauthorized confirmation, ownership) and signature verification are sound (C-1–C-11). Two **Medium** findings remain:

- **R-01** — credits deducted by `CreditGuard` are lost when `ValidationPipe` rejects the body (guards run before pipes; the refund lives in the handler).
- **R-02** — a webhook can capture an order with `creditsGranted == 0` when the package is no longer resolvable, with no fail-closed guard.

Plus four **Low/Informational** operational items (R-03 webhook rate-limit, R-04 reconciliation/alerting, R-05 F-12 gap, R-06 dead env var, R-07 `?token=` fallback, R-08 JSON type guard).

### Pre-go-live checklist

- [ ] Fix R-01 (refund on pipe-level 400) and add an E2E test.
- [ ] Fix R-02 (persist `creditsGranted` at order creation; fail closed on `null`/`<= 0`).
- [ ] Add per-IP rate limit to `/payments/webhook` (R-03).
- [ ] Add alerting/metrics for `amount_mismatch` / `not_found` / zero-grant outcomes (R-04, R-02).
- [ ] Reconcile F-12 wallet throttling (R-05) and the redundant `NEXT_PUBLIC_RAZORPAY_KEY_ID` (R-06).
- [ ] Remove the `?token=` auth fallback, at least for payment routes (R-07).
- [ ] Integration-test the S-01/S-06 DB races and the guard→deduct→refund chain against a real Postgres instance (per `05-security-hardening.md` §5.4).
- [ ] Manual sandbox E2E: real Razorpay test-mode payment + webhook tunnel, verifying credits are granted exactly once and the amount/currency cross-checks hold.

---

## 7. Related files

| File | Role |
|---|---|
| `01-audit.md` | Design-phase findings F-01–F-16 |
| `05-security-hardening.md` | Prior code-level pass, S-01–S-06 |
| `apps/server/src/payments/*` | Module under review |
| `apps/server/src/review/review.controller.ts`, `review.repository.ts`, `review.service.ts` | Credit-guard + refund wiring (R-01, C-10, C-11) |
| `apps/server/src/history/history.controller.ts` | Chat credit-guard + refund wiring (R-01) |
| `apps/server/src/main.ts`, `app.module.ts` | ValidationPipe (R-01), throttler config (R-03, R-05) |
| `apps/server/src/auth/auth.guard.ts` | `?token=` fallback (R-07) |
| `apps/client/app/account/page.tsx`, `lib/use-wallet.ts`, `lib/api.ts` | Client checkout + wallet polling (R-06) |

