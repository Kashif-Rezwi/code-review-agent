# Razorpay Integration — End-to-End Audit Report

> **Date:** 2026-08-14
> **Branch:** `payment-integration` @ `57e414c`
> **Mode:** Razorpay **Test Mode** (`rzp_test_TPUnqCp0SffIdf`)
> **Method:** Full static review + hands-on runtime testing against the live local stack (Docker `cra-server`/`cra-client`/`cra-redis`, Neon Postgres), a **real Razorpay test payment** (₹99, netbanking mock-bank), and **real Razorpay webhook delivery** through a temporary Cloudflare tunnel, plus ~40 crafted signed/unsigned webhook requests and concurrency/edge-case matrices.
> **Rule compliance:** No implementation code was modified. All fixtures were created via documented DB seeding and removed afterwards; the only repository change is this report. Temporary test state (tunnel, Razorpay webhook endpoint, fixture rows) was torn down / restored (see §13).

---

## 1. Executive Summary

The integration is **architecturally sound and the happy path is fully proven end-to-end against real Razorpay test-mode infrastructure** — a real payment was completed in a browser-driven Razorpay Checkout, Razorpay delivered a real signed `order.paid` webhook through a public tunnel, HMAC verification passed, and the wallet was credited exactly once with full DB evidence.

However, hands-on testing surfaced **three High-severity defects that prior static reviews missed**, plus one Medium state-management defect:

| # | Finding | Severity | Status |
|---|---|---|---|
| RZP-001 | `payment.failed` webhooks are parsed from the wrong payload path — **every real `payment.failed` event is silently dropped** | High | Broken |
| RZP-002 | Webhooks for unknown orders 500 on a FK violation — the graceful `not_found` path is dead code | High | Broken |
| RZP-003 | Latent: once RZP-001 is fixed, "failed-then-paid" orders can never be captured — **paid, zero credits** | High | Broken (latent) |
| RZP-004 | 3 abandoned checkouts permanently block further purchases — no order-expiry mechanism exists | Medium | Broken |
| RZP-005 | Concurrent duplicate webhook bursts intermittently 500 (P2028 transaction-start timeouts) | Medium | Partially working |
| RZP-006–013 | Body-parser pre-empts webhook JSON/validation defenses; body-cap drift; SSE error semantics; UX gaps; cancel-refund policy; shared test account | Low / Info | See §7 |

**Verdict: NOT production-ready** (details in §11). The defects are concentrated in failure/edge paths; the credit-granting hot path is correct, idempotent, and concurrency-safe. All High findings have small, well-understood fixes.

### What was proven with real infrastructure (not mocks)

- Real `POST /payments/order` → real Razorpay order → cross-checked via Razorpay Orders API ✅
- Real browser checkout → real payment `pay_TPWgDDhePTNmrA` (netbanking, auto-captured) ✅
- Real `order.paid` webhook delivered by Razorpay → signature verified → order CAPTURED, +50 credits, ledger + event rows correct ✅
- Real `payment.failed` webhook delivered by Razorpay → **exposed RZP-001** ✅ (as evidence)
- Exactly-once credit under 10-way concurrent duplicate webhook bursts ✅
- Fail-closed amount/currency/missing-amount mismatch handling ✅
- 402/400 refund chains (guard → interceptor → handler) against real Postgres ✅
- Anti-double-spend race, worker-failure refund (F-05) E2E ✅

---

## 2. Architecture Overview

Prepaid **credit wallet** model (decision D-4 in `docs/features/razorpay/`):

```
Browser (/account)                NestJS API                        Razorpay
─────────────────                 ──────────                        ────────
1. GET /payments/wallet ─────────►│ balance + ledger + packages (AuthGuard, 60/min)
2. POST /payments/order ─────────►│ AuthGuard → throttle 5/hr → pending-cap (3)
                                  │ Razorpay Orders.create(amount/currency from
   ◄── {orderId, razorpayOrderId, │ server-side CREDIT_PACKAGES) → PaymentOrder
        amount, currency, keyId}  │ row (CREATED, creditsGranted persisted)
3. new Razorpay({order_id...}) ──────────────────────────────────► Checkout.js
4. user pays ────────────────────────────────────────────────────► (test card/bank)
5. handler() → startPolling()     │                                 │
6. GET /payments/wallet ×N ──────►│ (2s × max 30 polls)             │
                                  │◄── POST /payments/webhook ──────│ order.paid /
                                  │    HMAC-SHA256(rawBody) vs      │ payment.failed
                                  │    RAZORPAY_WEBHOOK_SECRET      │
                                  │    → $transaction: PaymentEvent │
                                  │      (unique eventId) → amount/ │
                                  │      currency cross-check →     │
                                  │      CREATED→CAPTURED guard →   │
                                  │      creditBalance increment →  │
                                  │      PURCHASE ledger            │
```

Key design properties (verified unless noted):

- **No client-side verification endpoint (D-9).** `POST /payments/verify` does not exist (404 confirmed). Webhooks are the sole credit-grant path — the client can never mark a payment successful.
- **Amount/currency/credits are server-side only** (`credit-cost.policy.ts`); client supplies only `packageId`. Hostile extra fields (`userId`, `amount`, `creditsGranted`) are stripped by the global whitelist pipe (tested).
- **Idempotency:** `PaymentEvent.razorpayEventId` unique (layer 1) + status-guarded `CREATED → CAPTURED/FAILED` transitions (layer 2) + partial unique indexes for free-grant (S-01) and per-review refund (S-06).
- **Credit consumption:** `CreditGuard` pre-deducts via conditional decrement (`WHERE creditBalance >= cost`), `CreditRefundInterceptor` refunds when validation rejects post-deduction (R-01), handlers refund on failure (S-03/S-04), worker failure refunds atomically with `markFailed` (F-05).
- **Webhook is synchronous in-request** (no BullMQ), single Prisma `$transaction`, 200-ack semantics.

Files comprising the integration:

| Layer | Files |
|---|---|
| Server | `apps/server/src/payments/{payments.controller,webhook.controller,payments.service,payments.repository,credit.guard,credit-refund.interceptor,credit-cost.policy,credit-cost.decorator,payments.module}.ts`, `dto/create-order.dto.ts`; consumers: `review/review.controller.ts`, `review/review.service.ts`, `review/review.repository.ts`, `history/history.controller.ts`, `users/users.service.ts`, `auth/auth.guard.ts` |
| DB | `prisma/schema.prisma` (`User.creditBalance`, `PaymentOrder`, `PaymentEvent`, `CreditLedger`), migrations `20260813172114_add_payment_credit_models`, `20260814000000_add_credit_ledger_unique_indexes` |
| Client | `apps/client/app/account/page.tsx`, `lib/use-wallet.ts`, `lib/api.ts`, `proxy.ts` |
| Shared | `packages/types/src/index.ts` (`WalletResponseSchema`, `CreditPackageSchema`, `LedgerEntrySchema`) |
| Config | `apps/server/.env(.example)`, `apps/client/.env(.example)`, `render.yaml`, `docker-compose.yml` |

---

## 3. Environment & Test Setup

| Item | Value |
|---|---|
| Stack under test | Docker: `cra-server` (localhost:4000), `cra-client` (localhost:3000), `cra-redis`; DB = Neon Postgres (remote) |
| Auth for API tests | Real GitHub token via `gh auth token` (user `Kashif-Rezwi`, GitHub id `34582831`) → real `AuthGuard` → GitHub `/user` validation path |
| Razorpay mode | **Test** (`rzp_test_…`); API cross-checks with key/secret via `https://api.razorpay.com/v1` |
| Webhook delivery | Temporary Cloudflare quick tunnel → webhook endpoint registered **via Razorpay Webhooks API** (id `TPWW8Y2bhyU6eo`, events `order.paid` + `payment.failed`, secret = the configured `RAZORPAY_WEBHOOK_SECRET`) |
| Real payment | Browser-driven Razorpay Checkout (standalone page reusing the app's own order payload), netbanking mock-bank → Success |
| Baseline before testing | `pnpm build:packages` ✅ · `pnpm type-check` ✅ (4 projects) · server 31 suites/152 tests ✅ · client 10 files/16 tests ✅ · `pnpm lint` ✅ |
| Prior state | User had balance 20 (25 FREE_GRANT − 5 CONSUMPTION from an earlier review) |

- Rate limits (order 5/hr + pending-cap 3, wallet 60/min, webhook 100/min) verified by measurement ✅
- No secrets in client bundle; `?token=` blocked on payment routes; no client verify endpoint ✅

---

## 4. Happy Path — Step-by-Step Evidence

| Step | Expected | Observed | Evidence |
|---|---|---|---|
| 1. `GET /payments/wallet` | balance + ledger + packages | `200`, balance 20, 3 packages, matches `WalletResponseSchema` | curl response |
| 2. `POST /payments/order {packageId:"50"}` | 201, server-side amount | `201` `{orderId: 1dd0cac0-…, razorpayOrderId: order_TPWUruGm58ScHv, amount: 9900, currency: INR, keyId: rzp_test_…}` | curl response |
| 3. Razorpay-side order | matches local | `{amount:9900, amount_paid:0, currency:INR, receipt: 1dd0cac0-… (internal UUID), notes: {packageId:"50"} only, status: created}` | `GET /v1/orders/order_TPWUruGm58ScHv` |
| 4. Local order row | CREATED, credits persisted | `PaymentOrder{status: CREATED, creditsGranted: 50, userId: 34582831}` | Prisma query |
| 5. Checkout opens | Razorpay modal | Modal rendered; "Test Mode" badge visible | browser screenshots |
| 6a. Card attempt (4111…1111) | — | **Failed**: "business accepts domestic (Indian) card payments only" — `pay_TPWcBJcFlXdf1Y` status `failed` | Razorpay Payments API |
| 6b. Real `payment.failed` webhook | order → FAILED | **Delivered (real HMAC verification passed) but dropped**: `WARN payment.failed webhook missing order.entity.id (eventId: TPWcByyUTB1pWL)`; order stayed `CREATED`; **no PaymentEvent row** → **RZP-001** | server logs + DB |
| 7. Netbanking retry (mock bank → Success) | payment succeeds | `PAYMENT_SUCCESS`, handler fired with `{razorpay_payment_id: pay_TPWgDDhePTNmrA, razorpay_order_id, razorpay_signature}` | browser page state |
| 8. Razorpay order state | paid | `{status: "paid", amount_paid: 9900, attempts: 2}`; payment `captured: true` (auto-capture ON) | Razorpay API |
| 9. Real `order.paid` webhook | capture + credit | `LOG order.paid: captured order order_TPWUruGm58ScHv` | server logs |
| 10. DB state | all rows consistent | Order `CAPTURED` + `razorpayPaymentId=pay_TPWgDDhePTNmrA`; `PaymentEvent{TPWgRv1qnBhidP, order.paid}`; `CreditLedger{PURCHASE, +50, balanceAfter: 70, orderId set}`; `User.creditBalance 20 → 70` | Prisma queries |
| 11. Wallet reflects | balance 70 | `GET /payments/wallet` → `{balance: 70, ledger[0]: PURCHASE +50}` | curl |
| 12. App ↔ Razorpay consistency | match | Local CAPTURED ↔ Razorpay `paid`; amount/currency identical | above |

**Polling UX note:** the client polls `/payments/wallet` after `handler()` fires; the webhook landed ~1–2s after payment success here — well within the 30×2s polling window.


---

## 5. Working Correctly (verified, with evidence)

1. **Order creation** — validation (`@IsIn` packageIds), pending-cap, Razorpay call, local persistence, receipt=internal UUID, `notes` contain only `packageId` (F-10 no-PII confirmed via Razorpay API).
2. **Signature verification** — real Razorpay signature accepted; wrong/missing/malformed signatures → 401; HMAC computed over the **raw body** (proves `rawBody: true` works through Express 5/Nest 11 — closes 🟡 L-7 from `08-final-validation.md`).
3. **Idempotency layer 1 (event-id)** — duplicate `evt_audit_t11` → `200`, debug "duplicate event … no-op", single event row.
4. **Idempotency layer 2 (status guard)** — new event-id against already-CAPTURED order → `200` "already captured — idempotent no-op", balance unchanged.
5. **Exactly-once under concurrency** — 5-way same-event-id burst → 1 capture, balance +50 once; 10-way different-event-id burst → 1 capture (winner `pay_diff_3`), +50 once, 5 clean no-ops (4 requests 500'd — see RZP-005). Ledger `balanceAfter` chain gapless, always read from DB (F-04).
6. **Amount/currency fail-closed (F-09/S-02/S-05)** — wrong amount (100 vs 9900), wrong currency (USD), and missing `amount_paid` each: `200` ack, order stays `CREATED`, `[F-09] Mismatch …` error log, `*_mismatch` event recorded, **zero credits**. Recovery capture with correct values afterwards succeeded (order not poisoned).
7. **Zero-credits fail-closed (R-02)** — order with `creditsGranted=0` → not captured, `order.paid.zero_credits` event + error logs, no credits.
8. **Out-of-order safety (paid → stale failed)** — `order.paid` capture followed by late `payment.failed`: status guard blocks FAILED transition, order stays CAPTURED, credits kept.
9. **AuthN/AuthZ** — no token 401; garbage token 401 (GitHub API rejection); `?token=` on `/payments/*` 401 (R-07); wallet/orders scoped strictly to `req.user.userId` (no client-controllable identifiers exist); no endpoint mutates balance/ledger from client input.
10. **Input handling** — invalid/missing `packageId` → 400 with messages; hostile extra fields stripped (whitelist pipe) — order created with server-side amount/credits regardless of `userId`/`amount`/`creditsGranted` in body.
11. **Credit consumption** — guard deduction with ledger entry; 402 on insufficient balance (balance 2 vs cost 5), no ledger write; strict cost resolver rejects unknown `type` pre-deduction (F-06).
12. **Refund chains (real DB)** — R-01: DTO-400 after deduction → CONSUMPTION + CONSUMPTION_REFUND pair, net 0 (review and chat); F-05: PR review against nonexistent repo → deduction −10 → worker acquisition failure → atomic `markFailedAndRefund` +10 (review `FAILED`, refund entry present); S-03/S-04 handler refund paths verified in code + covered by controller specs.
13. **Anti-double-spend race** — balance exactly 5, two concurrent `/review/session` (5 credits each) → exactly one `201` + one `402`, balance 0.
14. **Successful paid review E2E** — the winning CODE review ran to `COMPLETE` (1 real LLM call), no refund issued on success.
15. **Rate limits measured** — wallet: exactly 60×200 then 429s; webhook: exactly 100×200 then 429s; order creation: 5/hr/user + pending-cap 429 with a distinct message.
16. **Body-size protection** — >1MB and 150KB signed bodies → 413 (see RZP-007 for nuance).
17. **Frontend gate** — `/account` unauthenticated → redirect to `/login`; client bundle contains **no** `RAZORPAY_KEY_SECRET`/`WEBHOOK_SECRET`/`rzp_test_*` strings (keyId delivered per-order by the server — R-06).
18. **Config hygiene** — `.env` files git-ignored (`git check-ignore` verified); `render.yaml` marks all three Razorpay vars `sync: false`; test keys only; no live-key usage.
19. **Error responses sanitized** — 500s return generic `Internal server error`; Razorpay SDK errors logged message-only (F-10); no stack/credential leakage observed in any response.
20. **Auto-capture dependency** — payment `captured: true` without any capture API call: account auto-capture is ON (architecture dependency satisfied).


---

## 6. Security Findings (adversarial review)

Severity-ranked summary; RZP-001/002/003 are detailed in §7 in the full finding format.

| Check | Result |
|---|---|
| API/webhook secrets exposed to client | ✅ None — bundle scanned; only publishable `keyId` leaves the server, per-order |
| `.env` committed | ✅ No — `.gitignore` + `git check-ignore` verified |
| Client-side payment trust | ✅ None — no verify endpoint (404); webhook-only crediting |
| Signature verification | ✅ Correct HMAC-SHA256 over raw Buffer, `timingSafeEqual`, format pre-check; wrong sig → 401 |
| Replay attack | ✅ Duplicate event-id → no-op (P2002 path) |
| Amount/currency manipulation | ✅ Fail-closed cross-check vs local order (tested: wrong/missing amount, wrong currency) |
| Order/payment ID manipulation by client | ✅ Not reachable — client never supplies these to any mutating endpoint |
| Cross-user theft (user A verifies user B's payment) | ✅ No API surface: wallet/order scope from token; webhook credits by order's `userId` FK |
| Ownership forgery via body | ✅ `userId` in body stripped by whitelist pipe (tested) |
| Auth fallback abuse | ⚠️ `?token=` blocked on `/payments/*` (R-07 verified) but still accepted on other routes (known L-3) — **RZP-011** |
| Webhook endpoint auth | ✅ HMAC-only (by design); throttled 100/min/IP |
| Webhook unknown-order handling | ❌ **500 FK violation** (RZP-002) — availability/robustness, not credit-safety |
| Failed-payment handling | ❌ **Silently dropped** (RZP-001); latent capture-block (RZP-003) |
| Credential leakage in logs | ✅ None observed across the full test window |
| Injection via webhook payload fields | ✅ Payload stored as JSONB post-verification; parameterized Prisma access only |

---

## 7. Detailed Findings

## RZP-001 — `payment.failed` webhooks are parsed from the wrong payload path and silently dropped

**Severity:** High
**Area:** Webhook / Backend
**Status:** Broken

### Description

`PaymentsService.handlePaymentFailed` reads the order id from `payload.order.entity.id`. Real Razorpay `payment.failed` events do **not** contain `payload.order`; the order reference lives at `payload.payment.entity.order_id`. Every genuine `payment.failed` delivery therefore hits the `!razorpayOrderId` early-return — the order never transitions to FAILED, and the `PaymentEvent` row is never written (no audit trail of the failure).

### Reproduction

Observed with a **real Razorpay delivery** (not a simulation):

1. Create order via `POST /payments/order` (`order_TPWUruGm58ScHv`).
2. Attempt payment in real Checkout with an international test card → payment fails (`pay_TPWcBJcFlXdf1Y`, error "domestic (Indian) card payments only").
3. Razorpay delivers `payment.failed` (event `TPWcByyUTB1pWL`) through the registered webhook.
4. Server log: `WARN [PaymentsService] payment.failed webhook missing order.entity.id (eventId: TPWcByyUTB1pWL)`.
5. DB: order remains `CREATED`; `PaymentEvent` count for the order = 0.

Controlled confirmation with the documented Razorpay payload shape (`payload.payment.entity.order_id`): same silent no-op (test `evt_fail_real`).

### Expected Behavior

Order transitions `CREATED → FAILED`; event recorded; failure visible for reconciliation.

### Actual Behavior

Silent drop after a warn log. `failOrder` and the F-14 status-guard are **dead code in production**.

### Evidence

- Code: `apps/server/src/payments/payments.service.ts` — `handlePaymentFailed` reads `(payload as { order?: { entity?: { id?: string } } }).order?.entity`
- Real payment: `GET /v1/payments/pay_TPWcBJcFlXdf1Y` → `{status: "failed", order_id: "order_TPWUruGm58ScHv"}` — the order id exists, inside `payment.entity`
- Server log line above; DB state queries
- Coverage gap: `grep -n 'payment.failed' apps/server/src/payments/*.spec.ts` → **no unit test exercises `payment.failed` at all** (why prior review passes missed this)

### Impact

- Failed payments never mark orders FAILED — orders linger CREATED (feeds RZP-004's pending-cap lock-out when users retry after failures).
- No audit trail of failed payment attempts (PaymentEvent gap).
- Failure-based reconciliation/reporting is impossible.
- **Dangerous interaction with RZP-003:** the day this parsing is fixed naively, failed-then-paid orders become un-creditable.

### Notes

Fix must read `payload.payment.entity.order_id` (keeping the `payload.order.entity.id` fallback) and land **together with** the RZP-003 state-machine fix.


---

## RZP-002 — Webhooks referencing unknown orders 500 on a PaymentEvent FK violation

**Severity:** High
**Area:** Webhook / Database
**Status:** Broken

### Description

`captureOrder` (and `failOrder`) insert the `PaymentEvent` row **first**, with `razorpayOrderId` FK-referencing `PaymentOrder.razorpayOrderId`. For an order not present locally, the insert violates `PaymentEvent_razorpayOrderId_fkey` (P2003) → unhandled 500. The intended `not_found` graceful path (log error, return 200) is unreachable — the lookup happens after the insert.

### Reproduction

`POST /payments/webhook` with a validly-signed `order.paid` for `order_UNKNOWN_audit`:

```
HTTP:500 {"statusCode":500,"message":"Internal server error"}
```

Server log: `PrismaClientKnownRequestError … Foreign key constraint violated … PaymentEvent_razorpayOrderId_fkey, code: 'P2003'` (stack through `payments.repository.ts` → `handleOrderPaid`). Independently reproduced for `payment.failed` (`handlePaymentFailed`, same constraint).

### Expected Behavior

Skip/park the event (schema already allows `razorpayOrderId: null`), log the revenue-relevant error, return 200 so Razorpay stops retrying.

### Actual Behavior

500 → Razorpay treats the delivery as failed and retries (documented retry window up to ~24h), amplifying noise. The event is not persisted anywhere.

### Evidence

- Code: `payments.repository.ts` `captureOrder` step 1 (`tx.paymentEvent.create` before the `findUnique`); schema FK `PaymentEvent.razorpayOrderId → PaymentOrder.razorpayOrderId`
- Live 500 responses + P2003 server logs (two independent occurrences)

### Impact

- Any `order.paid` for an order missing locally — the documented orphaned-order case (Razorpay order created, local insert failed), or **events from other applications sharing this Razorpay account** (this test account contains foreign orders from Sept 2025 — RZP-012) — produces repeated 500s and lost reconciliation signals.
- A legitimate paying customer whose local row is missing can never be auto-credited, even across retries.

### Notes

Fix direction: look up the order **before** inserting the event; insert the audit event with `razorpayOrderId: null` when unknown.

---

## RZP-003 — Latent: `payment.failed` → retry → `order.paid` can never grant credits (FAILED is terminal for capture)

**Severity:** High (latent — currently masked by RZP-001)
**Area:** Database / Backend state machine
**Status:** Broken (latent)

### Description

`failOrder` transitions `CREATED → FAILED`; `captureOrder` only transitions from `CREATED`. Razorpay orders support **multiple payment attempts**: a failed attempt followed by a successful retry on the *same* order yields `payment.failed` then `order.paid`. Once an order is FAILED, the subsequent `order.paid` hits the status guard, logs the misleading message "already captured — idempotent no-op", and grants **no credits — for real money paid**.

### Reproduction

1. Seed `PaymentOrder{razorpayOrderId: order_AUDIT_FAIL2, status: CREATED, creditsGranted: 50}`.
2. Signed `payment.failed` with the code's expected payload shape → `200`; order → `FAILED`; event recorded.
3. Signed `order.paid` (correct amount/currency) → `200`; order **stays FAILED**, `razorpayPaymentId` null, balance unchanged, log says "already captured".

### Expected Behavior

A paid order must be captured (and credited) regardless of a prior failed attempt; at minimum it must not be a silent/mislogged no-op — it needs loud reconciliation handling (money arrived, entitlement not granted).

### Actual Behavior

Silent financial-loss path: payment captured by Razorpay, customer receives nothing, order terminally FAILED.

### Evidence

- Live state sequence above (Prisma queries at each step)
- Code: `payments.repository.ts` `captureOrder` step 4 (`where: { razorpayOrderId, status: 'CREATED' }`) and `failOrder` (`CREATED → FAILED`)

### Impact

Today: unreachable in production because RZP-001 prevents FAILED transitions — the system currently "works by accident". After a naive RZP-001 fix: **every customer who fails one attempt and retries successfully loses their payment**. The two fixes must ship together: allow `FAILED → CAPTURED` when `order.paid` arrives (or treat `payment.failed` as non-terminal for capture purposes).

### Notes

The reverse ordering (paid → stale failed) is safe: verified the FAILED transition is blocked after CAPTURED.


---

## RZP-004 — Abandoned-checkout lock-out: pending-order cap has no expiry

**Severity:** Medium
**Area:** Backend / Database state
**Status:** Broken

### Description

`createOrder` rejects new orders when 3 orders are `CREATED` (F-11), with the message *"please complete or wait for them to expire."* But **nothing ever transitions a CREATED order to EXPIRED** — `grep -rn 'EXPIRED' apps/server/src` returns zero non-comment references. A user who opens and abandons 3 checkouts is permanently blocked from purchasing (until manual DB intervention or a webhook event for those orders, which abandonment never produces).

### Reproduction

1. Have 3 orders in `CREATED` (created via API, never paid).
2. Next `POST /payments/order` → `429 {"statusCode":429,"message":"You have too many pending orders — please complete or wait for them to expire."}`
3. Confirm: no code path writes `EXPIRED`; Razorpay-side order expiry generates no webhook to this integration.

### Expected Behavior

CREATED orders older than Razorpay's order TTL should transition to EXPIRED (sweeper job or lazy expiry on read), releasing the cap.

### Actual Behavior

Permanent 429 after 3 abandonments; the error message promises an expiry that never happens.

### Evidence

429 responses during testing; `EXPIRED` grep result; `02-architecture.md` §7 documents orphaned-order expiry only for the Razorpay side.

### Impact

Self-inflicted purchase lock-out; support burden; misleading UX copy. (Known limitation L-2 partially covers this; the cap interaction makes it user-facing rather than back-office.)

---

## RZP-005 — Concurrent duplicate webhook bursts intermittently 500 (P2028)

**Severity:** Medium
**Area:** Webhook / Reliability
**Status:** Partially working

### Description

Under concurrent delivery of the same logical event, some requests fail with Prisma `P2028` ("Unable to start a transaction in the given time") — interactive `$transaction` acquisition times out while contending on the unique event-id row / order row against remote Neon round-trips.

Observed: 5-way same-event-id burst → 2× 500, 3× 200. 10-way different-event-id burst on one order → 4× 500, 6× 200.

### Expected Behavior

Duplicate deliveries are routine for webhooks; all should return 200 promptly.

### Actual Behavior

500s; **credit integrity held** (exactly-once verified in both bursts — balance +50 once, single PURCHASE entry, single winner event). Razorpay's retry-on-5xx makes this self-healing in practice.

### Evidence

Burst outputs; server logs show `P2028 Transaction API error: Unable to start a transaction in the given time` at the `payments.repository` capture path.

### Impact

No double-credit risk. Noisy retries; in pathological retry storms could repeatedly 500 and delay crediting.

### Notes

Mitigations: catch P2028/P2034 alongside P2002 and treat as duplicate-ack; or insert the event with `createMany({skipDuplicates:true})` + row-count check before opening the interactive transaction; consider a transaction `maxWait` bump.


---

## RZP-006 — Webhook JSON defenses are dead code: the global body parser rejects first (400)

**Severity:** Low
**Area:** Webhook
**Status:** Partially working

`handleWebhook` defensively handles non-JSON bodies and non-object JSON (R-08), intended to ack-200. In practice Nest's global JSON parser runs first: non-JSON → 400 (`Unexpected token … not valid JSON`); a bare primitive (`12345`) → 400 (strict mode rejects non-object/array roots). Razorpay always sends valid JSON objects, so this is theoretical — but the documented "parse failures return 200" behavior (`02-architecture.md` §7.2) does not occur, and Razorpay would retry on the 400.

**Evidence:** `send-webhook.js 'this-is-not-json'` → `HTTP:400`; `'12345'` → `HTTP:400`.

---

## RZP-007 — Webhook body-size cap (1 MB, F-03) is unreachable; body-parser's ~100 KB default fires first

**Severity:** Low
**Area:** Configuration / Backend
**Status:** Partially working

The controller checks `rawBody.length > 1_048_576`, but no explicit JSON body limit is configured in `main.ts`, so the Express/body-parser default (~100 KB) rejects first. Verified: a 150 KB validly-signed body → `413 "request entity too large"` (body-parser's message, not the app's `PayloadTooLargeException`). Protection is effective (stricter than designed) but the F-03 guard and `PaymentsService.maxWebhookBodyBytes` never execute — code/docs drift.

**Evidence:** `main.ts` (no body-limit config); 150 KB → 413; >1 MB → 413.

---

## RZP-008 — Chat validation failures surface as HTTP 201 + SSE error frame (not 400)

**Severity:** Low
**Area:** Frontend / API semantics
**Status:** Partially working

`POST /history/:id/chat` is `@Sse()`. A DTO failure (`{}`) is deducted-then-refunded correctly (R-01 chain verified: −1/+1 ledger pair), but the HTTP response is `201` with an `event: error` SSE frame (`data: Bad Request Exception`) rather than a 400. Clients must treat SSE error frames as failures; a naive client could misread 201 as success.

---

## RZP-009 — Frontend payment-failure UX gaps

**Severity:** Low
**Area:** Frontend
**Status:** Working (with gaps)

- The app registers only `handler` (success) and `modal.ondismiss` — **no `payment.failed` listener**. Failures are communicated only by Razorpay's checkout UI (observed: checkout stays open with "Retry payment" — acceptable); dismissing after a failure leaves the page silent about the failed attempt.
- Polling (2s × 30 = up to 30/min) approaches the wallet throttle (60/min); two tabs polling simultaneously plus navigation can exceed it. Polling errors are silently swallowed (by design) — worst case the "Syncing Wallet…" banner runs its 60s and stops.

**Evidence:** `apps/client/app/account/page.tsx` (Razorpay options), `lib/use-wallet.ts` (catch-and-ignore); throttle measured at exactly 60/min.

---

## RZP-010 — User-cancelled reviews are not refunded

**Severity:** Low (product decision to confirm)
**Area:** Backend / State
**Status:** Working as coded

`markCancelled` transitions PENDING → CANCELLED without a refund; the worker's `ReviewCancelledError` path returns early (no `markFailedAndRefund`). Credits are burned on cancellation even if cancelled before dispatch. Failure paths refund; cancellation does not. If intentional, document it in the UI; if not, add a compensating `CONSUMPTION_REFUND`.

**Evidence:** `review.repository.ts markCancelled`; `review.service.ts` cancellation block.

---

## RZP-011 — `?token=` auth fallback remains active on non-payment routes

**Severity:** Low (known L-3, re-confirmed live)
**Area:** Security / Auth
**Status:** Working (deprecated)

`GET /history?token=<token>` → 200. Payment routes correctly reject it (401). URL tokens leak via logs/history/referrers — track removal.

**Evidence:** tests A3/A4; `auth.guard.ts` lines 33–43.

---

## RZP-012 — Razorpay test account is shared with another application

**Severity:** Informational
**Area:** Configuration
**Status:** Observed

`GET /v1/orders` shows foreign orders (Sept 2025) from a different app, with `userId`/`userEmail` in `notes` (PII — this repo's F-10 policy correctly avoids that). Implications: (a) webhook endpoints are account-wide — while the audit endpoint was registered, events for the other app's orders would have hit our handler and 500'd (RZP-002); (b) test-data commingling. Use a dedicated Razorpay account for production rehearsals.

---

## RZP-013 — Minor observations

**Severity:** Informational

- `order.paid` without `payment.entity` stores `razorpayPaymentId: ''` (empty string) — cosmetic; prefer null (`payments.service.ts` `razorpayPaymentId ?? ''`).
- The "already captured — idempotent no-op" log fires for orders that were never captured (e.g. FAILED) — misleading during incident response (seen in RZP-003 repro).
- Neon serverless scale-to-zero causes periodic `P1001`/`P1017` "Review dispatch poll failed" errors (self-recovering; observed at idle, unrelated to payment paths — but the same transient conditions during webhook bursts surface as P2028-class 500s, RZP-005).
- `packages/types` wallet schemas matched all live responses (no drift).


---

## 8. Webhook Audit Summary

| Check | Result |
|---|---|
| Endpoint reachable / correct method | ✅ `POST /payments/webhook` only; GET → 404 |
| Raw-body handling | ✅ HMAC over raw Buffer verified with **real** Razorpay signature (`rawBody: true` works at runtime) |
| Signature verification / invalid rejected | ✅ 401 for missing / malformed / wrong signatures |
| Event-id header required | ✅ 400 when missing / >128 chars |
| Duplicate events | ✅ same-id → no-op; concurrent same-id → exactly-once (with P2028 noise, RZP-005) |
| Unsupported events | ✅ 200 ack, debug log, no state change (`payment.authorized` tested) |
| Idempotent processing | ✅ proven at both layers (event unique key + status guard) |
| Only correct user's records updated | ✅ credits follow `PaymentOrder.userId` FK — no user input in the path |
| Failure logging | ✅ appropriate levels; ⚠️ no alerting (known L-1); misleading "already captured" message (RZP-013) |
| No benefits for invalid events | ✅ every invalid/mismatch case granted zero credits |
| Unknown-order events | ❌ 500 FK violation (RZP-002) |
| `payment.failed` processing | ❌ dropped at parsing (RZP-001); latent capture-block (RZP-003) |
| Body-size guard | ⚠️ effective via body-parser default, not the F-03 code (RZP-007) |
| Malformed JSON | ⚠️ 400 from parser, not the designed 200-ack (RZP-006) |

---

## 9. Database / State Audit Summary

- **Records created/updated correctly** on the happy path (order, event, ledger, balance) — verified field-by-field.
- **Unique constraints respected**: `razorpayOrderId`, `razorpayEventId`, partial FREE_GRANT and CONSUMPTION_REFUND indexes — enforced and exercised.
- **Status transitions**: `CREATED → CAPTURED` guarded; `CREATED → FAILED` guarded; terminal states immutable — with the RZP-003 caveat (FAILED terminally blocks legitimate later payments).
- **No inconsistent state from duplicates/races** — exactly-once verified under 5-way and 10-way concurrency; `balanceAfter` chain gapless across all audit-era transitions.
- **Failed payments** never grant access ✅ (but also never record/transition — RZP-001).
- **Partial failures**: mismatch/zero-credit paths leave orders CREATED *by design* for reconciliation (with error logs + marker events) ✅.
- **Fixture cleanup restored** the DB to its legitimate state (see §13).

---

## 10. Configuration & Observability

| Item | Status |
|---|---|
| `RAZORPAY_KEY_ID` = `rzp_test_…` (test mode) | ✅ |
| `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` server-only | ✅ (never in responses, logs, or client bundle) |
| `.env` not committed | ✅ git-ignored |
| `render.yaml` secrets `sync: false` | ✅ |
| No `NEXT_PUBLIC_RAZORPAY_KEY_ID` needed (R-06) | ✅ client `.env` confirmed clean |
| Webhook URL registration | ✅ via Razorpay Webhooks API (temporary; deactivated post-test) |
| Auto-capture (dashboard) | ✅ inferred ON — payment `captured: true` with no capture call |
| Log usefulness | ✅ good signal (`[F-09]`, `[R-02]`, event ids); ❌ no alerting layer (known L-1); Neon idle P1001/P1017 noise |
| Error response sanitization | ✅ no internals leak in 500s |


---

## 11. Production Readiness Assessment

### Verdict: **Not Production Ready** — three High findings must be fixed first

The integration's **core money path is strong**: order creation, checkout, real webhook verification, exactly-once crediting, mismatch fail-closed behavior, refund chains, and rate limiting all passed hands-on testing, including concurrency stress. This is materially further along than `docs/features/razorpay/08-final-validation.md` ("never run against real Razorpay") — the four 🔴 manual gates listed there are now **closed**:

1. ✅ Real test-mode payment → webhook → credit grant (proven, §4)
2. ✅ Webhook registration + event subscription (done via API)
3. ✅ Auto-capture confirmed (payment `captured: true`)
4. ✅ Duplicate-delivery idempotency against real and simulated traffic

**Blockers before production:**

1. **RZP-001 + RZP-003 (must ship together)** — parse `payment.entity.order_id` *and* allow capture of previously-FAILED orders (or make `payment.failed` non-terminal for capture). Add the missing `payment.failed` unit/integration tests with **real-shaped payloads**.
2. **RZP-002** — reorder lookup-before-insert (or insert the audit event with `razorpayOrderId: null`) so unknown-order events ack 200 with a logged reconciliation signal.
3. **RZP-004** — add CREATED-order expiry (sweeper or lazy expiry) so the pending cap can't permanently lock out purchasers.

**Should-fix (not blockers):** RZP-005 (map P2028/P2034 to duplicate-ack), RZP-006/007 (align parser limits and docs), RZP-008 (document SSE error semantics for clients), RZP-009 (failure UX + polling/throttle headroom), RZP-010 (decide and document cancel-refund policy), RZP-012 (dedicated test account), plus the pre-existing L-1 alerting and L-2 reconciliation job.

**Estimated effort:** the three blockers are small, localized changes in `payments.service.ts` / `payments.repository.ts` plus tests and one scheduled job.

---

## 12. Untested / Unable to Verify

| Item | Why not tested | Residual risk |
|---|---|---|
| Interactive `/account` page UI behind GitHub OAuth | Automation browser cannot complete the user's GitHub OAuth login | Low — page code statically reviewed; wallet hook unit-tested; the checkout flow itself was driven in a standalone page using the app's own API responses |
| Successful *card* payment path in Checkout | Test account is domestic-only; 4111…1111 rejected as international; netbanking mock-bank used instead | Low — Razorpay-side difference only; webhook handling is method-agnostic |
| Razorpay-initiated **retry** after a 5xx from our endpoint | All observed 500s came from *simulated* requests (no Razorpay retry loop engaged) | Low — Razorpay retry behavior is documented; dedup handles redelivery |
| UPI flows, refunds/disputes, settlements | Out of integration scope (no refund/dispute handlers exist) | Note: `refund.*` events would currently be ignored (safe: 200 ack + debug log) |
| Multi-user concurrency (two distinct GitHub users) | One GitHub account available | Low — all user scoping derives from the verified token; no cross-user input exists |
| Chat happy-path streaming deduction (S-04 stream-failure refund) | Avoided extra LLM spend beyond the approved budget; deduction+refund pair verified via the validation path; S-04 covered by code review + unit tests | Low |
| Post-audit verification-loop re-run | Repo was never modified during testing; baseline was green before testing and no source files changed | None (DB state re-verified after cleanup) |


---

## 13. Test Artifacts, Fixtures, and Cleanup (full disclosure)

**Temporary infrastructure (removed/disabled):**

- Cloudflare quick tunnel `*.trycloudflare.com` → stopped (`cloudflared` was installed via Homebrew for this audit; the binary remains installed on the machine).
- Razorpay webhook endpoint `TPWW8Y2bhyU6eo` — the Webhooks API has no DELETE; it was **deactivated and re-pointed to a dead placeholder URL** (`https://example.com/payments/webhook-disabled`). Recommend deleting it in the Razorpay Dashboard (Settings → Webhooks) for hygiene.
- Standalone checkout page `/tmp/rzp-checkout.html`, helpers `/tmp/rzp-audit/*`, container helper `/app/.audit-db.js`, screenshots `/tmp/rzp-step*.png` — ephemeral `/tmp` artifacts (the container file disappears on the next container rebuild).

**DB fixtures (created for testing, all removed):** seeded orders `order_AUDIT_CONC01/02`, `order_AUDIT_MM01`, `order_AUDIT_FAIL1/2`, `order_AUDIT_OOO1`, `order_AUDIT_ZERO1`; two real-but-unpaid orders created via API (`order_TPZjn6WguycnnE`, `order_TPZnpSXi8dRAE0` — Razorpay-side they expire unpaid naturally); all fixture PaymentEvent/CreditLedger rows deleted; **balance restored to its legitimate value 70** (20 pre-audit + 50 from the one real, retained test purchase).

**Retained (legitimate records):** `order_TPWUruGm58ScHv` (CAPTURED, `pay_TPWgDDhePTNmrA`) + its event `TPWgRv1qnBhidP` + PURCHASE ledger entry; two audit-era reviews (`cmssnosmh…` COMPLETE — one real LLM call as approved; `cmssnq9mx…` FAILED — refunded).

**Environment side effects:** throttle counters (in-memory) and the AuthService token cache were exercised; both expire naturally. No migrations, no source edits, no `.env` changes.

---

## Appendix — Test Matrix Results (condensed)

| Test | Result |
|---|---|
| Happy path: order → checkout → real payment → webhook → credits → wallet | ✅ Pass (§4) |
| Failed card payment → real `payment.failed` webhook | ❌ Dropped silently (RZP-001) |
| Failed → retry same order → paid | ⚠️ Works today only because of RZP-001; blocked once fixed (RZP-003) |
| Webhook: no/bad/wrong signature; missing event-id | ✅ 401/400 |
| Webhook: unknown event type; missing order id in payload | ✅ 200 no-op |
| Webhook: unknown order | ❌ 500 P2003 (RZP-002) |
| Webhook: malformed JSON / non-object JSON | ⚠️ 400 from parser (RZP-006) |
| Webhook: >1MB / 150KB bodies | ✅ 413 (via body-parser; RZP-007) |
| Duplicates: same event-id; same order new event-id; 5×/10× concurrent | ✅ exactly-once (⚠️ P2028 500s — RZP-005) |
| Amount / currency / missing-amount mismatch | ✅ fail-closed, no credits, recoverable |
| Zero-credits order | ✅ fail-closed (R-02) |
| Out-of-order paid→failed | ✅ stays CAPTURED |
| Auth: none/garbage/`?token=`/ownership/verify-404/whitelist strip | ✅ all pass |
| Pending cap ×3 → 429; expiry | ⚠️ cap works; no expiry exists (RZP-004) |
| Throttles: order 5/hr; wallet 60/min; webhook 100/min | ✅ measured exactly |
| Credits: deduction; 402; double-spend race; R-01 refund; F-05 worker refund | ✅ all pass |
| Cancel review | ⚠️ no refund by design (RZP-010) |
| Secrets/config/client bundle | ✅ clean |

*Report generated from live evidence gathered on 2026-08-14. All commands were read-only against the repository; DB mutations were the fixtures listed in §13.*

