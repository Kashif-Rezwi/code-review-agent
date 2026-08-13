# Razorpay Payment Integration — Security Hardening

> **Stage:** Security design review
> **Scope:** Design-phase hardening pass on `02-architecture.md` and `03-implementation-plan.md`.
> **Status of implementation:** `04-implementation.md` does not yet exist — no source code has been written. This document reviews the design documents as the current source of truth and produces requirements that must hold in the implementation.
> **Author:** Security pass performed 2026-08-13.

---

## 0. Preliminary: 04-implementation.md does not exist

The request asks to read `04-implementation.md` before proceeding. That file does not exist — the implementation has not been started. This hardening pass therefore:

1. Treats `02-architecture.md` and `03-implementation-plan.md` as the authoritative design.
2. Produces security requirements that the implementation **must** satisfy.
3. Amends both design documents with corrections and additions.
4. Records all findings here so they can be verified once code exists.

No claim of "verified in code" is made — code does not yet exist. Claims of verification below are verified against the **design documents** only, and test specifications required to verify the property are stated explicitly.

---

## 1. Threat model

### 1.1 Trust boundaries

```
 UNTRUSTED                                      TRUSTED
 ────────                                       ───────
 Browser / client code           │   NestJS API server
 - Sends requests with a         │   - AuthGuard validates
   GitHub Bearer token           │     tokens via GitHub API
 - Drives Razorpay Checkout.js   │   - All credit mutations
 - Observes wallet balance       │     happen server-side
                                 │   - Secrets never leave server
                                 │
 Razorpay servers (webhook)      │   Razorpay servers (API calls)
 - Unauthenticated HTTP POST     │   - Called from server, HTTPS
 - Must be verified via HMAC     │   - API key used as credential
   before any processing         │
```

### 1.2 Attacker capabilities

| Attacker class | Capability |
|---|---|
| **Authenticated user — honest** | Normal use; has a valid GitHub token; gets correct credits |
| **Authenticated user — manipulative** | Valid token, tries to manipulate amounts, forge signatures, race deductions |
| **Unauthenticated internet actor** | No token; targets webhook endpoint, public endpoints |
| **Replay attacker** | Captures a valid webhook payload; replays it at a later time |
| **Race attacker** | Opens multiple concurrent sessions to trigger double-spend |
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

Findings are categorised by severity: **CRITICAL**, **HIGH**, **MEDIUM**, **LOW**, **INFO**.

---

### F-01 — CRITICAL: `rawBody` used for HMAC but not explicitly typed as `Buffer`

**Where:** Architecture §5.2, implementation plan Chunk 7 / `webhook.controller.ts`

**Vulnerability:** The design instructs reading `req.rawBody` and passing it to HMAC verification. NestJS 11 with `{ rawBody: true }` populates `req.rawBody` as a `Buffer`. However, if the controller accidentally uses `req.body` (the parsed JSON object) instead of `req.rawBody`, or converts `req.rawBody.toString()` before hashing, the signature check will silently pass on a tampered body (string/JSON round-trip normalises whitespace). No guard in the design prevents this confusion.

**Why it exists:** The design says "read `req.rawBody`" but does not specify the type contract or that `req.rawBody` must be used as a `Buffer` directly — it is easy for an implementer to inadvertently stringify it.

**Fix:** The implementation plan must require:
1. `req.rawBody` is used directly as a `Buffer` — not converted to a string first.
2. The HMAC is computed as `crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')`.
3. The `timingSafeEqual` comparison uses two equal-length `Buffer`s: `Buffer.from(computedHex, 'hex')` and `Buffer.from(signatureHeader, 'hex')`.
4. If `signatureHeader` is missing or not a 64-character hex string, reject immediately before attempting `timingSafeEqual` — passing mismatched-length buffers to `timingSafeEqual` throws a `RangeError`.

**Status:** Design fix required. Test required: a spec that sends a valid payload with a tampered body (single whitespace change) must return `401`.

---

### F-02 — CRITICAL: Missing length/format guard before `timingSafeEqual`

**Where:** Architecture §5.2

**Vulnerability:** `crypto.timingSafeEqual(a, b)` throws a `RangeError` if `a.length !== b.length`. An attacker who sends an `X-Razorpay-Signature` header of arbitrary length (e.g., an empty string, or a 1-character string) will cause an uncaught exception in the webhook handler. If the exception propagates as a `500`, Razorpay retries — creating an infinite retry loop that can exhaust the server. If caught by a global exception filter, the response status is non-deterministic.

**Why it exists:** The design specifies `timingSafeEqual` without specifying the pre-condition check.

**Fix:** Before calling `timingSafeEqual`:
1. Verify the signature header is present.
2. Verify it is exactly 64 hex characters (HMAC-SHA256 hex output is always 64 characters).
3. If either fails → return `401` immediately.

**Status:** Design fix required. Test required: send an empty signature header → must return `401` (not `500`).

---

### F-03 — HIGH: Webhook payload is stored as `Json` without size limit

**Where:** Architecture §4.1 `PaymentEvent.payload`

**Vulnerability:** The full Razorpay webhook payload is stored as a Postgres `Json` column with no size constraint. A maliciously large or malformed webhook body (attacker sends a POST with a 10 MB body claiming to be Razorpay) could exhaust memory or Postgres row limits. The HMAC verification happens before storage, so authentic attacker payloads are rejected — but see F-01: if signature verification is bypassed by a bug, arbitrary data is stored. Additionally, a legitimate Razorpay payload is bounded by Razorpay, but the server should not trust that bound without enforcing its own.

**Why it exists:** The design stores the full payload for audit without specifying a body-size limit on the webhook route.

**Fix:** 
1. The webhook route must enforce a strict body-size limit (recommended: 1 MB, which is far larger than any legitimate Razorpay payload of ~10–50 KB).
2. NestJS uses Express's `express.json()` globally with a default 100 KB limit. With `{ rawBody: true }`, the raw body middleware also buffers. An explicit limit must be set.
3. Reject payloads exceeding the limit before HMAC verification (return `413`).

**Status:** Design fix required (add body-size limit specification to implementation plan).

---

### F-04 — HIGH: `balanceAfter` in `CreditLedger` is computed by the application, not derived from the DB

**Where:** Architecture §4.1 `CreditLedger`, §5.1

**Vulnerability:** The design specifies recording `balanceAfter` — the balance snapshot after a credit mutation. This value is computed by the application layer: after a successful `updateMany`, the application increments/decrements the known amount to derive `balanceAfter`. If the application computes this incorrectly (e.g., uses a cached balance, or computes outside the transaction), the ledger's `balanceAfter` can diverge from `User.creditBalance`, corrupting the audit trail silently.

**Why it exists:** Prisma does not return the post-update value of the `creditBalance` field from an `updateMany` call — the application must either re-read the balance or compute it.

**Fix:** Within the same `$transaction`, after the `updateMany` on `User`, issue a `findUnique` to read the updated `creditBalance` and store that as `balanceAfter`. Do not compute `balanceAfter` arithmetically outside the transaction. This guarantees the ledger always reflects the actual DB state.

**Status:** Design fix required (add this requirement to repository method specifications in implementation plan §Chunk 7 and §Chunk 8).

---

### F-05 — HIGH: Double-refund race on `CONSUMPTION_REFUND`

**Where:** Architecture §7.4, implementation plan Chunk 8 `review.service.ts`

**Vulnerability:** The design specifies that when a review fails, `refundCredits()` is called. The plan says "refund only happens when review transitions to `FAILED` — the same status-guard pattern prevents double-refund." However, `ReviewRepository.markFailed` uses `updateMany` with a status-guard, which is the right pattern. But the `refundCredits()` call described in the plan is a **separate operation** from `markFailed` — it is called after `markFailed`, not inside the same transaction.

This creates a window: if the server crashes between `markFailed` succeeding and `refundCredits` being called, the review is marked `FAILED` but credits are not returned. Worse, the review is now in a terminal state so the next restart won't retry `markFailed`. The user permanently loses credits for a failed review.

Additionally: the design does not specify an idempotency guard on the refund itself. If something calls `refundCredits` twice for the same `reviewId` (e.g., a bug or retry), credits are doubled.

**Fix:** 
1. The `markFailed` + `refundCredits` calls must be wrapped in a single `$transaction`. If they cannot be (because the repository and service layers are separate), the repository's `markFailed` method must be extended to atomically issue the refund as part of the same transaction.
2. Add a unique constraint: `CreditLedger` should enforce that at most one `CONSUMPTION_REFUND` entry exists per `reviewId`. This prevents double-refund regardless of how many times the code path is triggered.

**Status:** Design fix required (architecture §7.4 and implementation plan Chunk 8 must be updated).

---

### F-06 — HIGH: Credit guard reads `req.body.type` — injection from body after ValidationPipe

**Where:** Implementation plan Chunk 8, micro-decision M-1

**Vulnerability:** The plan proposes that `CreditGuard` reads `req.body.type` to determine the credit cost (CODE_REVIEW vs PR_REVIEW). The `ValidationPipe({ whitelist: true })` is applied globally and strips unknown fields. However:
1. The guard accesses the already-parsed `req.body` object.
2. If someone sends a crafted body where `type` is neither `CODE` nor `PR` (which the DTO validator normally rejects), and if there is any path where the DTO validation runs after the guard, the guard's `req.body.type` lookup could resolve to `undefined` → cost defaults to `0` → free operation.

The plan says "Guard runs after `AuthGuard` and after `ValidationPipe` (body is parsed)" — this is **only true for the `@Body()` parameter**. In NestJS, `ValidationPipe` as a global pipe runs on route handler parameters, which happens **after** guards. Guards run before pipes in NestJS's execution order: `Middleware → Guards → Interceptors (pre) → Pipes → Handler → Interceptors (post)`.

This means: `CreditGuard` runs **before** `ValidationPipe`. An attacker who sends `{ "type": "FAKE", "input": "..." }` will cause:
- `CreditGuard` reads `req.body.type === "FAKE"` → `getCreditCost("FAKE")` → if the function returns a fallback of `0` → free operation.
- Then `ValidationPipe` rejects with `400` — but credits have already been deducted (or not deducted, which is the security risk).

**Fix:** The credit guard must not trust `req.body.type` for the cost calculation. Instead:
- **Option A (preferred):** Use two separate guards — `CreditGuardCode` applied to the code-review route and `CreditGuardPR` applied to the PR-review route — each with a hardcoded cost. This eliminates the need to read the body type.
- **Option B:** Use a decorator metadata factory: `@CreditCost((req) => getCostFromType(req.body?.type))` and have the guard call the factory, but also enforce that an invalid type defaults to the most expensive cost (not zero).
- Either way: if the cost resolves to `0` or is not a positive integer, the guard must reject with `400`.

**Status:** This is a design correction that supersedes M-1 in `03-implementation-plan.md`.

---

### F-07 — HIGH: `captureOrder` transaction step ordering allows credit without order capture

**Where:** Implementation plan Chunk 7, `payments.repository.ts` `captureOrder()` steps 1–5

**Vulnerability:** The transaction steps are ordered as:
1. Insert `PaymentEvent` (idempotency)
2. `updateMany` on `PaymentOrder` CREATED → CAPTURED
3. Check `count === 0` → return early
4. `updateMany` on `User` → increment `creditBalance`
5. Insert `CreditLedger`

**If the transaction fails between step 4 and step 5** (e.g., a Postgres error inserting the ledger entry), the transaction rolls back entirely — which is correct. However, the `$transaction` in Prisma uses interactive transactions by default. The failure scenario is safe because Prisma rolls back.

**However:** If an implementer uses Prisma's batch transactions (`$transaction([...])` array form) rather than the callback form, operations are not wrapped in a single atomic unit — they are sent as individual statements. The design does not specify which form to use.

**Fix:** Explicitly require use of Prisma's **interactive transaction** (callback form: `prisma.$transaction(async (tx) => { ... })`) for all multi-step payment writes. The batch array form must be explicitly prohibited for `captureOrder`, `deductCredits`, `refundCredits`, and `grantFreeCredits`.

**Status:** Design fix required (add this requirement to implementation plan §Chunk 7 repository specification).

---

### F-08 — MEDIUM: `x-razorpay-event-id` header used for idempotency but not validated

**Where:** Architecture §4.3, implementation plan Chunk 7

**Vulnerability:** The `razorpayEventId` (from the `x-razorpay-event-id` header) is stored in `PaymentEvent.razorpayEventId` as the idempotency key with a unique index. The design does not specify any validation of this header value. An attacker who:
1. Knows a previously-processed event ID (from a log leak, or by guessing)
2. Can send a valid HMAC signature (requires the webhook secret, which would be a separate compromise)

Could replay any previous event. However, this is defense-in-depth since:
- The HMAC must still be valid (F-01 covers this)
- The order-level status guard (step 2 of `captureOrder`) prevents re-capture

The actual risk: if `x-razorpay-event-id` is missing, the implementation may either crash (accessing `undefined`) or store `null`, which breaks the unique index's purpose.

**Fix:** Validate that `x-razorpay-event-id` is present, is a non-empty string, and is at most 128 characters. If missing → return `400` (not `200`) after logging. This is safe because Razorpay always sends this header — a missing header implies a spoofed request that passed HMAC verification, which is worth investigating rather than silently acking.

**Status:** Design fix required.

---

### F-09 — MEDIUM: Order amount verification against local record not specified for webhook

**Where:** Architecture §2 flow step 11, implementation plan Chunk 7

**Vulnerability:** When `order.paid` arrives, the webhook handler uses the `razorpayOrderId` from the payload to look up the local `PaymentOrder` and grant `creditsGranted` credits. The design correctly prevents the client from setting the amount. However, the webhook handler does not verify that the amount in the webhook payload (`payload.order.entity.amount_paid`) matches the amount recorded in the local `PaymentOrder.amountPaise`.

An attacker who can manipulate the Razorpay order (e.g., a Razorpay-side bug, or an attacker who compromised Razorpay) could theoretically send a webhook for an order with a lower amount than was created. The credits granted should correspond to what was actually paid, not a higher amount.

In the prepaid credit model, credits granted come from `CREDIT_PACKAGES[order.packageId].credits` (resolved from the local record), so the client cannot inflate credits by manipulating the webhook payload. **However**, confirming that `amountPaise` in the local order matches the webhook payload amount is an important consistency check that also catches server-side bugs.

**Fix:** In `handleOrderPaid()`, after resolving the local `PaymentOrder` by `razorpayOrderId`, verify that `localOrder.amountPaise === payload.order.entity.amount_paid` (Razorpay reports in paise). If they don't match, log a critical alert and return `200` (do not grant credits, do not crash). Record this as a discrepancy event in `PaymentEvent` with type `order.paid.amount_mismatch`.

**Status:** Design fix required (add amount cross-check to architecture §2 and implementation plan §Chunk 7).

---

### F-10 — MEDIUM: Sensitive data in Razorpay `notes` field could be logged by the SDK

**Where:** Architecture §2 flow step 2, implementation plan Chunk 6

**Vulnerability:** The design specifies passing `notes: { userId, packageId }` to `Razorpay.orders.create()`. The Razorpay `notes` field is sent over the network to Razorpay's API and appears in their dashboard. This is acceptable for `packageId`. However, `userId` is the GitHub numeric user ID — a non-secret but an internal identifier. More importantly: the Razorpay SDK may log the full request/response on error, including the notes field. If the server's log level is set to `debug` or `verbose`, this could log user identifiers in structured log output.

Additionally, if the `RAZORPAY_KEY_SECRET` is exposed through SDK error messages (e.g., a 401 from Razorpay includes the key in an error message), it must not be logged.

**Fix:** 
1. Wrap all Razorpay SDK calls in a `try/catch` that catches, sanitises, and re-throws errors without logging raw SDK error objects (which may contain credentials).
2. The `Logger.error()` call must use `err.message` only, never `JSON.stringify(err)` or `err` directly.
3. Razorpay `notes` should include only `packageId` (not `userId`) — the `userId` is already captured in the local `PaymentOrder.userId` field and does not need to flow to Razorpay.

**Status:** Design fix required (refine what goes in `notes`, add error sanitisation requirement).

---

### F-11 — MEDIUM: No maximum pending orders per user (D-11 "handled carefully" undefined)

**Where:** Architecture §2, audit §6.2 ("optional soft cap on concurrent PENDING orders per user")

**Vulnerability:** Decision D-11 allows multiple concurrent orders per user and notes "handled carefully — server-side safeguards". The architecture describes a rate limit (5/hr) but does not implement a maximum concurrent PENDING order count. An attacker could create 5 orders in one hour, let them sit in `CREATED` status, then create 5 more after the rate limit resets, accumulating a large number of open orders.

This is not a direct money-extraction attack, but it:
1. Pollutes the database with abandoned orders.
2. Increases the blast radius if an attacker ever forges a webhook (they could match against many PENDING orders).
3. Creates operational noise in the Razorpay dashboard.

**Fix:** Add a guard in `createOrder()`: before calling Razorpay's API, count the user's `CREATED` orders in the local DB. If the count exceeds a soft cap (recommended: 3), reject with `429` and message "You have too many pending orders — please complete or wait for them to expire." This prevents unbounded accumulation without affecting legitimate use.

**Status:** Design fix required (add to architecture §9 endpoint summary and implementation plan §Chunk 6).

---

### F-12 — MEDIUM: `GET /payments/wallet` returns no rate limit — balance polling could be abused

**Where:** Architecture §9, implementation plan Chunk 5

**Vulnerability:** `GET /payments/wallet` has no rate limit specified. The client is designed to poll it every 2 seconds for up to 60 seconds after checkout. If many authenticated users are simultaneously polling (or if an attacker creates many authenticated sessions), this endpoint could generate significant DB load. The wallet query returns `balance + ledger (last 50 entries)` per request.

**Fix:** Add a modest rate limit to `GET /payments/wallet` — recommended 60 requests per minute per user (matching the chat rate limit). This is high enough to not affect the polling use case (30 requests/60 seconds = 30 req/min) but caps runaway polling.

**Status:** Design fix recommended. Update architecture §9 table.

---

### F-13 — LOW: `NEXT_PUBLIC_RAZORPAY_KEY_ID` returned from `GET /payments/wallet`

**Where:** Implementation plan Chunk 5 `payments.service.ts` `getWallet()`, Chunk 10 client

**Vulnerability / Design inconsistency:** The `getWallet()` response is specified to include `packages` (available credit packages). The client then uses this to open the Checkout popup with the returned `keyId`. However, `keyId` (`RAZORPAY_KEY_ID`) is a publishable key that is already available in the client as `process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID`. There is no reason to include it in the `getWallet()` response — this unnecessarily exposes the key in API responses and complicates the client-server contract.

Additionally, when `createOrder()` returns `{ orderId, razorpayOrderId, amount, currency, keyId }`, the `keyId` is included in the response. This is actually correct — the client needs it to instantiate the Razorpay Checkout object. But the amount returned must be validated client-side to match what the user expects.

**Fix:** The `getWallet()` response should NOT include `keyId`. The client should use `process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID` directly. The `createOrder()` response may include `keyId` for convenience (it is a publishable key).

**Status:** Low-severity design inconsistency — fix in implementation plan §Chunk 10 and `@cra/types` schema.

---

### F-14 — LOW: `payment.failed` webhook updates order to `FAILED` — no guard against `CAPTURED → FAILED` transition

**Where:** Architecture §3 state machine, implementation plan Chunk 7

**Vulnerability:** The state machine correctly shows all transitions go from `CREATED`. The `failOrder()` repository method is described as "atomic status-guard transition `CREATED → FAILED`". However, the plan does not explicitly state that the `WHERE` clause in `failOrder()` must include `status = CREATED`. If an implementer writes `updateMany` without the status guard, a `payment.failed` webhook arriving after a successful `order.paid` (out of order) could overwrite `CAPTURED` → `FAILED`, destroying a valid credit grant. This is the same idempotency pattern as `captureOrder` but must be equally explicit.

**Fix:** Explicitly specify that `failOrder()` uses `updateMany` with `WHERE status = 'CREATED'` — return `count: 0` silently if the order is already in a terminal state. Document this as a test case: `payment.failed` for an already-CAPTURED order → no-op.

**Status:** Design fix required (make the WHERE clause explicit in implementation plan repository specification).

---

### F-15 — LOW: `grantFreeCredits` called on every login — partial failure window

**Where:** Implementation plan Chunk 9, architecture §6.3

**Vulnerability:** `grantFreeCredits` is called from `UsersService.findOrCreate` on every authenticated request. The unique partial index on `CreditLedger` prevents double-granting. However: if the `$transaction` that does (INSERT CreditLedger + UPDATE User.creditBalance) fails after the ledger insert but before the balance update (e.g., a DB connection drop mid-transaction), the transaction rolls back — which is correct. The next login retries correctly.

The real risk: if a new user's first authenticated request triggers `findOrCreate`, which calls `grantFreeCredits`, which succeeds, but then the same user's `AuthService.resolve()` is called by 10 concurrent requests (normal browser behaviour on page load), all 10 call `grantFreeCredits` concurrently. The unique index handles this, but 9 of the 10 transactions will fail with a unique constraint violation and the error handling must return the successful result (not throw).

**Fix:** In `grantFreeCredits()`, catch `P2002` (Prisma unique constraint error) and return cleanly (no-op). Do not re-throw. Log at `debug` level only.

**Status:** Existing design notes this but does not specify the error code. Add explicit error code handling to the implementation plan.

---

### F-16 — INFO: `receipt` field in Razorpay order creation

**Where:** Architecture §2 flow step 2

**Vulnerability:** The design sends `receipt: <orderId>` when creating a Razorpay order. The `receipt` field is displayed in the Razorpay dashboard and has a maximum length of 40 characters. The `orderId` is a CUID (26 characters) — within limit. This is correct.

However, the design should explicitly specify that the `receipt` field contains only the internal `orderId` (not the user ID, email, or any PII), since the `receipt` field appears in the Razorpay dashboard and merchant-facing reports.

**Status:** Informational — confirm during implementation.

---

## 3. Findings fixed (design-level corrections)

The following findings require updates to `02-architecture.md` and `03-implementation-plan.md`. The updates are applied in §5 below.

| Finding | Severity | Correction location |
|---|---|---|
| F-01 | CRITICAL | Architecture §5.2 + plan §Chunk 7 |
| F-02 | CRITICAL | Architecture §5.2 + plan §Chunk 7 |
| F-03 | HIGH | Architecture §7.2 + plan §Chunk 7 |
| F-04 | HIGH | Architecture §4.1 + plan §Chunk 7, 8 |
| F-05 | HIGH | Architecture §7.4 + plan §Chunk 8 |
| F-06 | HIGH | Plan §Chunk 8, micro-decision M-1 → replaced |
| F-07 | HIGH | Plan §Chunk 7 repository specification |
| F-08 | MEDIUM | Architecture §4.3 + plan §Chunk 7 |
| F-09 | MEDIUM | Architecture §2 + plan §Chunk 7 |
| F-10 | MEDIUM | Architecture §2, plan §Chunk 6 |
| F-11 | MEDIUM | Architecture §9 + plan §Chunk 6 |
| F-12 | MEDIUM | Architecture §9 |
| F-13 | LOW | Plan §Chunk 10, shared types |
| F-14 | LOW | Plan §Chunk 7 |
| F-15 | LOW | Plan §Chunk 9 |
| F-16 | INFO | Architecture §2 (no change needed) |

---

## 4. Findings intentionally not changed and why

| Finding | Reason not changed |
|---|---|
| **F-16** (`receipt` field PII) | Informational — the design already sends `orderId` only. No change needed; confirm at implementation time. |
| **No rate limit on `GET /payments/wallet` (F-12)** — partial | The fix is added to the design, but the implementation will decide the exact `@Throttle` value; the design now specifies a 60 req/min floor. |
| **Webhook retries returning `200` for unknown orders** | Architecture §7.2 already covers this with the correct behaviour (200 + log warning). An unknown order is not a security vulnerability — it is a cross-environment mismatch or data loss scenario. Returning `4xx` would trigger indefinite Razorpay retries. The design is correct as-is. |
| **No CSRF protection on `/payments/order`** | The endpoint requires a valid GitHub Bearer token in the `Authorization` header. CSRF attacks against Bearer-token endpoints are not possible — the browser's CORS policy prevents cross-site requests from including the token in the `Authorization` header (only same-site scripts can read and forward the token). No change needed. |
| **Razorpay Checkout.js loaded from external CDN** | Razorpay's Checkout.js is their official hosted script. Using a pinned SRI hash would be ideal but Razorpay does not provide one for their rotating script. This is a known limitation of third-party payment flows. The risk is accepted. |
| **`User.email` being `null` passed to Razorpay** | F-10 removes `userId` from notes; `email` is never sent. No issue. |

---

## 5. Verification requirements

Since no code exists, these are test requirements that must be satisfied before the feature is considered "done" from a security perspective.

### 5.1 Webhook verification tests (must fail without the fix)

| Test ID | Description | Expected result |
|---|---|---|
| WH-01 | Send valid payload with valid HMAC → expect `200` | Pass |
| WH-02 | Send valid payload with invalid HMAC → expect `401` | Pass |
| WH-03 | Send valid payload with missing `X-Razorpay-Signature` header → expect `401` | Pass |
| WH-04 | Send valid HMAC but body modified (1 char changed) → expect `401` | Pass |
| WH-05 | Send empty `X-Razorpay-Signature` header → expect `401` (not `500`) | F-02 |
| WH-06 | Send `X-Razorpay-Signature` of length 1 → expect `401` (not `500`) | F-02 |
| WH-07 | Body larger than limit → expect `413` | F-03 |
| WH-08 | Missing `x-razorpay-event-id` → expect `400` | F-08 |
| WH-09 | Duplicate `x-razorpay-event-id` → expect `200` + no second credit | Architecture §4.3 |
| WH-10 | `payment.failed` after `order.paid` (same order) → expect `200` + no status change | F-14 |

### 5.2 Credit guard tests

| Test ID | Description | Expected result |
|---|---|---|
| CG-01 | Code review request with sufficient credits → deducts 5, allows | Pass |
| CG-02 | PR review request with sufficient credits → deducts 10, allows | Pass |
| CG-03 | Insufficient credits (balance < cost) → `402` | Pass |
| CG-04 | Body with `type: "FAKE"` → rejected before credit deduction | F-06 |
| CG-05 | Two concurrent requests with total balance = cost → only one succeeds | F-06 / §5.1 |
| CG-06 | Failed review → credits refunded exactly once | F-05 |

### 5.3 Order creation tests

| Test ID | Description | Expected result |
|---|---|---|
| OC-01 | Valid `packageId` → creates order | Pass |
| OC-02 | Unknown `packageId` → `400` | Pass |
| OC-03 | No auth → `401` | Pass |
| OC-04 | Fourth concurrent CREATED order (over soft cap) → `429` | F-11 |
| OC-05 | Amount in response matches `CREDIT_PACKAGES[packageId].amountPaise` | F-09 |

### 5.4 Wallet tests

| Test ID | Description | Expected result |
|---|---|---|
| WL-01 | Authenticated user → sees own balance | Pass |
| WL-02 | No auth → `401` | Pass |
| WL-03 | Response does not include `keyId` | F-13 |
| WL-04 | `balanceAfter` in ledger matches `User.creditBalance` | F-04 |

---

## 6. Remaining risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Razorpay-side breach (webhook secret or order data) | Very low | Critical | HMAC verification still required; server-side order amount cross-check (F-09) |
| Neon DB outage during webhook processing | Low | Medium | Razorpay retries for 24 hours; risk window is bounded |
| Render cold-start during webhook delivery (audit §6.8) | Medium | Low | Razorpay retries; harmless with idempotent handler |
| Unique partial index not supported by Prisma natively (A-6) | Medium | Medium | Fallback: catch `P2002` at application level (already noted as assumption) |
| `timingSafeEqual` API change in future Node.js | Very low | Low | Pinned Node.js version in Dockerfile; monitor Node.js changelog |
| Log aggregator capturing full request body before HMAC verification | Medium | High | Ensure NestJS request logging middleware does not log raw body on webhook route |
| Checkout.js CDN unavailability (Razorpay CDN down) | Low | Medium | User cannot pay; the Account page shows an error. No credit-safety risk. |

---

## Related files

| File | Role |
|---|---|
| [`02-architecture.md`](./02-architecture.md) | Amended with F-01, F-02, F-03, F-04, F-05, F-07, F-08, F-09, F-10, F-11, F-12 fixes |
| [`03-implementation-plan.md`](./03-implementation-plan.md) | Amended with all findings |
| [`00-context.md`](./00-context.md) | Source of decisions D-1 through D-14 |
| [`01-audit.md`](./01-audit.md) | Source of security risks §6 |
