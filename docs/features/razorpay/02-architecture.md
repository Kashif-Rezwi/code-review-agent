# Razorpay Payment Integration — Architecture

> **Stage:** Implementation design (no source code changes)
> **Prerequisite:** [`00-context.md`](./00-context.md) (decisions D-1 through D-14) and [`01-audit.md`](./01-audit.md) (repository audit).
> **Related:** [`03-implementation-plan.md`](./03-implementation-plan.md) (executable file-by-file plan).

This document defines the system design: payment flow, state machine, database schema, security model, and the resolution of the two deferred questions from `00-context.md`.

---

## 1. Resolution of deferred questions

### 1.1 Webhook event subset (was deferred question #1)

**Decision:** Subscribe to **two** Razorpay webhook events:

| Event | Handler action |
|---|---|
| `order.paid` | **Primary credit path.** Transitions the local `PaymentOrder` to `CAPTURED`, atomically credits the user's wallet, and appends a `PURCHASE` ledger entry. Chosen over `payment.captured` because the payload includes both the order and payment entities, making reconciliation straightforward without an extra API call. |
| `payment.failed` | **Observability only.** Logs the failure and updates the `PaymentOrder` to `FAILED` (if not already in a terminal state). Does **not** alter credits. Enables alerting and helps surface failed attempts in the user's transaction history. |

**Why not `payment.captured`?** With auto-capture enabled (the default and our configuration), `order.paid` fires atomically once the order is fully paid. `payment.captured` carries only the payment entity — to resolve the associated order, we'd need a DB lookup by `razorpayPaymentId` or a Razorpay API call. `order.paid` already includes the `razorpayOrderId` in `payload.order.entity.id`, so the lookup is direct.

**Why not `payment.authorized`?** Auto-capture is enabled; authorization is immediately followed by capture, so this event carries no additional business value for the prepaid-credit model.

**Idempotency key:** `x-razorpay-event-id` header → stored as `PaymentEvent.razorpayEventId` (unique index). Duplicate deliveries are acked with `200` and no-oped.

### 1.2 GST / tax invoicing (was deferred question #2)

**Decision:** **Out of scope for v1.** Razorpay's Invoices API integration is deferred until the business has a confirmed GST registration and tax-advisory guidance on digital goods. The `PaymentOrder` schema records `amountPaise` and `currency` — sufficient input for any future invoicing layer. This decision is recorded as an ADR-style note; when invoicing is needed, it will be a new feature chunk with its own migration (possibly a `TaxInvoice` model linked to `PaymentOrder`).

---

## 2. Payment flow — end to end

```
 Browser (Next.js)                     NestJS API                         Razorpay
 ────────────────                     ──────────                         ────────
       │                                   │                                 │
   1.  │─── POST /payments/order ─────────►│                                 │
       │    { packageId: "100" }           │                                 │
       │    Authorization: Bearer <token>  │                                 │
       │                                   │                                 │
   2.  │                                   │─── Orders.create() ────────────►│
       │                                   │    amount: 9900 (paise)         │
       │                                   │    currency: INR                │
       │                                   │    receipt: <orderId>           │
       │                                   │    notes: { packageId }         │
       │                                   │    (no userId — avoids PII      │
       │                                   │     in Razorpay dashboard, F-10)│
       │                                   │                                 │
   3.  │                                   │◄── { id: order_xyz } ──────────│
       │                                   │                                 │
   4.  │                                   │  Create PaymentOrder row        │
       │                                   │  status: CREATED                │
       │                                   │                                 │
   5.  │◄── { orderId, razorpayOrderId, ──│                                 │
       │      amount, currency, keyId }    │                                 │
       │                                   │                                 │
   6.  │  Open Razorpay Checkout popup     │                                 │
       │  (Checkout.js, client-side)       │                                 │
       │                                   │                                 │
   7.  │                                   │                   User pays ──►│
       │                                   │                                 │
   8.  │  handler(response) fires          │                                 │
       │  { razorpay_payment_id,           │                                 │
       │    razorpay_order_id,             │                                 │
       │    razorpay_signature }           │                                 │
       │                                   │                                 │
   9.  │  Begin polling GET /payments/wallet                                 │
       │                                   │                                 │
  10.  │                                   │◄── POST /payments/webhook ─────│
       │                                   │    X-Razorpay-Signature: <sig>  │
       │                                   │    X-Razorpay-Event-Id: <eid>   │
       │                                   │    { event: "order.paid", ... } │
       │                                   │                                 │
  11.  │                                   │  Verify HMAC-SHA256 signature   │
       │                                   │  Check PaymentEvent idempotency │
       │                                   │  $transaction:                  │
       │                                   │    Insert PaymentEvent          │
       │                                   │    Update PaymentOrder → CAPTURED│
       │                                   │    Increment User.creditBalance │
       │                                   │    Insert CreditLedger (PURCHASE)│
       │                                   │                                 │
  12.  │                                   │── 200 OK ─────────────────────►│
       │                                   │                                 │
  13.  │◄── { balance, ledger } ──────────│                                 │
       │  Polling sees updated balance     │                                 │
```

### Key design choices in this flow

1. **No `/payments/verify` endpoint** (D-9). The client never sends `razorpay_signature` to our server. Razorpay webhooks are the sole credit-source path — this eliminates an entire class of client-side trust issues.
2. **Client polls `GET /payments/wallet`** after the Checkout popup closes. Polling interval: 2 seconds, max 30 attempts (60 seconds). If the balance hasn't updated, the UI shows "Payment is being processed" rather than an error — the webhook will arrive eventually (Razorpay retries for up to 24 hours).
3. **Webhook is synchronous in-request** — no BullMQ job. The entire credit path runs in a single Prisma `$transaction` and returns `200` to Razorpay before any side effects (e.g., future email notifications). This matches safety rail #5 (no auto-retries on BullMQ).

---

## 3. Payment order state machine

```
                    ┌─────────┐
   order created ──►│ CREATED │
                    └────┬────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌────────────┐
    │ CAPTURED │  │  FAILED  │  │  EXPIRED   │
    │ (terminal)│  │(terminal)│  │ (terminal) │
    └──────────┘  └──────────┘  └────────────┘
```

| Status | Meaning | Transition trigger |
|---|---|---|
| `CREATED` | Order created via Razorpay API; awaiting payment | `POST /payments/order` success |
| `CAPTURED` | Payment captured; credits granted | `order.paid` webhook (only from `CREATED`) |
| `FAILED` | Payment attempt failed | `payment.failed` webhook (only from `CREATED`) |
| `EXPIRED` | Order expired without payment | Future reconciliation script (optional v1) |

**Transition safety:** All state transitions use `updateMany` with a `where` clause that guards the current status — the same pattern used by [`ReviewRepository.markFailed`](../../../apps/server/src/review/review.repository.ts) and [`ReviewRepository.markCancelled`](../../../apps/server/src/review/review.repository.ts). This prevents:
- A `CAPTURED` order from being re-captured (double credit)
- A `FAILED` order from being captured (stale webhook ordering)
- Any terminal state from being overwritten

---

## 4. Database design

### 4.1 New Prisma models

All additions go into a **single new migration** (safety rail #1 — never edit an applied migration).

#### `PaymentOrder`

```prisma
enum OrderStatus {
    CREATED
    CAPTURED
    FAILED
    EXPIRED
}

model PaymentOrder {
    id                String      @id @default(cuid())
    userId            String
    user              User        @relation(fields: [userId], references: [id])
    razorpayOrderId   String      @unique
    razorpayPaymentId String?
    packageId         String                    // credit package identifier (e.g. "100", "500")
    amountPaise       Int                       // Razorpay amounts are integer paise
    currency          String      @default("INR")
    creditsGranted    Int         @default(0)   // 0 until CAPTURED
    status            OrderStatus @default(CREATED)
    createdAt         DateTime    @default(now())
    updatedAt         DateTime    @updatedAt

    events            PaymentEvent[]
    ledgerEntries     CreditLedger[]

    @@index([userId])
    @@index([status, createdAt])
}
```

**Design rationale:**
- `razorpayOrderId` is `@unique` — the natural idempotency key for order creation. If a double-click creates two Razorpay orders, each gets its own `PaymentOrder` row (allowed by D-11), credited independently.
- `packageId` is a string referencing a credit-cost-policy entry (not an enum) — allows adding new packages without a migration.
- `amountPaise` is `Int`, not `Float` or `Decimal` — Razorpay amounts are always integer paise (§6.9 in audit).
- `creditsGranted` starts at 0 and is set atomically during the `CAPTURED` transition — prevents any inconsistency between the order and the ledger.

#### `PaymentEvent`

```prisma
model PaymentEvent {
    id               String       @id @default(cuid())
    razorpayEventId  String       @unique       // x-razorpay-event-id header — idempotency key
    razorpayOrderId  String?
    order            PaymentOrder? @relation(fields: [razorpayOrderId], references: [razorpayOrderId])
    eventType        String                     // "order.paid", "payment.failed"
    payload          Json                       // full Razorpay event payload
    processedAt      DateTime     @default(now())
    createdAt        DateTime     @default(now())

    @@index([razorpayOrderId])
}
```

**Design rationale:**
- `razorpayEventId` is `@unique` — the primary idempotency mechanism. Before processing, the handler attempts to insert this row; a unique constraint violation means the event was already processed → ack `200` and return.
- `razorpayOrderId` is nullable for forward compatibility with events that don't carry an order reference.
- `payload` stores the full event as `Json` for audit/debugging — matches the existing `Review.traceLog` pattern.
- **Size-limited payload (F-03):** Only store the payload after the body-size limit check in §5.2. A `PaymentEvent` row is not created for rejected (oversized or invalid) requests.

#### `CreditLedger`

```prisma
enum LedgerEntryType {
    FREE_GRANT
    PURCHASE
    CONSUMPTION
    CONSUMPTION_REFUND
}

model CreditLedger {
    id           String          @id @default(cuid())
    userId       String
    user         User            @relation(fields: [userId], references: [id])
    type         LedgerEntryType
    amount       Int                           // positive for grants/purchases/refunds, negative for consumption
    balanceAfter Int                           // snapshot of creditBalance after this entry
    orderId      String?                       // for PURCHASE entries
    order        PaymentOrder?   @relation(fields: [orderId], references: [id])
    reviewId     String?                       // for CONSUMPTION / CONSUMPTION_REFUND entries
    description  String?                       // human-readable note (e.g. "Code review", "PR review")
    createdAt    DateTime        @default(now())

    @@index([userId, createdAt])
}
```

**Design rationale:**
- Append-only ledger — entries are never updated or deleted. The `balanceAfter` snapshot enables ledger reconstruction and audit.
- `amount` is signed: positive for credits in (grants, purchases, refunds), negative for credits out (consumption). This matches accounting convention and simplifies querying.
- `orderId` and `reviewId` are nullable foreign keys — a `PURCHASE` entry links to an order; a `CONSUMPTION` entry links to the review that consumed the credits.
- **`balanceAfter` must come from the DB (F-04):** After every credit mutation, `balanceAfter` must be populated by re-reading `User.creditBalance` inside the same `$transaction` using the transaction client (e.g., `tx.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } })`). It must never be computed arithmetically in application code from a cached or pre-read value.

#### `User` additions

```prisma
model User {
    // ... existing fields ...
    creditBalance  Int       @default(0)

    orders         PaymentOrder[]
    ledgerEntries  CreditLedger[]
}
```

**Design rationale:**
- `creditBalance` is the single source of truth for "can this user afford this operation?" All mutations go through atomic `updateMany` with a `where` guard (see §5.1 below). The ledger is the audit trail; the balance is the hot-path read.
- Default `0` means existing users start with no credits — the free-credit grant is a separate, idempotent operation triggered on first login.

### 4.2 Indexes

| Table | Index | Purpose |
|---|---|---|
| `PaymentOrder` | `razorpayOrderId` (unique) | Webhook lookup by Razorpay order ID |
| `PaymentOrder` | `[userId]` | User's order history |
| `PaymentOrder` | `[status, createdAt]` | Reconciliation queries (find stale `CREATED` orders) |
| `PaymentEvent` | `razorpayEventId` (unique) | Idempotency — duplicate event detection |
| `PaymentEvent` | `[razorpayOrderId]` | Event history per order |
| `CreditLedger` | `[userId, createdAt]` | User's transaction history (wallet page) |

### 4.3 Idempotency strategy

Three layers of idempotency, each independently sufficient:

1. **Event-level:** `PaymentEvent.razorpayEventId` unique index. Duplicate webhook deliveries (same `x-razorpay-event-id`) are rejected at insert time → ack `200`, no processing.
2. **Order-level:** `PaymentOrder` status-guard transition. The `updateMany` `where` clause requires `status: CREATED` → if the order is already `CAPTURED`, the update returns `count: 0` → no credit is added.
3. **Transaction-level:** Steps 1 and 2 run inside a single Prisma `$transaction`. Either both the event insert and the order update succeed, or neither does.

### 4.4 Migration naming convention

Following the existing pattern (`20260812054909_add_hot_path_indexes`), the migration will be named:

```
YYYYMMDDHHMMSS_add_payment_credit_models
```

---

## 5. Security design

### 5.1 Credit deduction: atomic conditional decrement (anti-double-spend)

The critical race condition described in audit §6.11: two concurrent requests each read `creditBalance = 10`, both pass a naive check, both deduct — balance goes negative.

**Solution:** Single-query atomic conditional decrement in a `$transaction`:

```
Step 1: updateMany({ where: { id: userId, creditBalance: { gte: cost } }, data: { creditBalance: { decrement: cost } } })
Step 2: If count === 0 → 402 Payment Required (insufficient credits)
Step 3: If count === 1 → Insert CONSUMPTION ledger entry (with balanceAfter) in same transaction
```

Postgres evaluates the `WHERE` against the row being updated under a row-level lock, so at most one concurrent request wins when the balance can only cover one. This mirrors the `updateMany` status-guard pattern already used by `ReviewDispatcherService` and `ReviewRepository`.

### 5.2 Webhook signature verification

The following sequence must be implemented exactly, in this order:

```
1. Read X-Razorpay-Signature header
2. If header is missing or not exactly 64 hex characters → return 401 immediately
   (timingSafeEqual throws RangeError if buffer lengths differ — F-02)
3. Read req.rawBody as a Buffer — never stringify it first (F-01)
4. signature = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
                     .update(req.rawBody)          ← Buffer, not string
                     .digest('hex')
5. comparison = crypto.timingSafeEqual(
     Buffer.from(signature, 'hex'),
     Buffer.from(signatureHeader, 'hex')
   )
6. If comparison === false → return 401
7. Only now: parse the body and proceed
```

**Implementation details:**
- `rawBody` requires `NestFactory.create(AppModule, { rawBody: true })` in `main.ts`. This adds `req.rawBody` as a `Buffer` on every request without affecting how `req.body` is parsed for existing routes.
- The webhook route is **not** guarded by `AuthGuard`.
- The webhook route must **not** be processed by the global `ValidationPipe({ whitelist: true })` — the payload is Razorpay's shape, not ours. This is handled by using `@Req()` to access the raw request directly, not `@Body()` with a DTO.
- Timing-safe comparison prevents timing attacks that could probe for the correct HMAC.
- Reject with `401` on signature mismatch — before any DB reads.
- **Body-size limit (F-03):** The webhook route must enforce a maximum body size of **1 MB**. Payloads exceeding this must be rejected with `413` before HMAC verification. This prevents memory exhaustion from oversized payloads.
- **Event-ID validation (F-08):** The `x-razorpay-event-id` header must be present and must be a non-empty string of at most 128 characters. If missing or invalid, return `400` (not `200`) — a missing event ID cannot occur on a legitimate Razorpay request.

### 5.3 What the client is allowed to send

| Field | Trusted? | Why |
|---|---|---|
| `packageId` in `POST /payments/order` | **Validated** | Must match a known key in the credit-cost policy. The server resolves the amount and credit count from the policy — the client never sends amounts. |
| `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` from Checkout callback | **Ignored** | The client receives these from Razorpay but does NOT send them to our server (D-9). Credits are applied only via webhook. |

### 5.4 What must be trusted only from the backend

| Data | Enforcement |
|---|---|
| `userId` on order creation | Derived from `req.user` (set by `AuthGuard`). Never trusted from the request body. |
| Credit amount per package | Resolved server-side from `credit-cost.policy.ts`. Never sent by the client. |
| Razorpay order amount | Set server-side when calling `Orders.create()`. Never influenced by client input beyond `packageId`. |
| Payment completion | Only via verified Razorpay webhook. Client cannot mark a payment as complete. |
| Credit balance mutations | Only via server-side `$transaction` (purchase credit, consume credit, refund credit). Client reads balance but never writes it. |

### 5.5 How secrets are stored

| Secret | Location | Visibility |
|---|---|---|
| `RAZORPAY_KEY_ID` | Server `.env` + `render.yaml` | Also exposed to client as `NEXT_PUBLIC_RAZORPAY_KEY_ID` (publishable) |
| `RAZORPAY_KEY_SECRET` | Server `.env` + `render.yaml` (`sync: false`) | **Server only** — never sent to the client |
| `RAZORPAY_WEBHOOK_SECRET` | Server `.env` + `render.yaml` (`sync: false`) | **Server only** — used only for webhook HMAC verification |

### 5.6 Payment ownership verification

- `GET /payments/wallet` filters by `req.user.userId` — a user can only see their own balance and ledger.
- `PaymentOrder` rows are created with `userId` from `req.user` — a user cannot create orders for other users.
- The webhook handler doesn't check user auth (it's server-to-server from Razorpay), but the order's `userId` was set at creation time — the webhook credits the correct user by following the `PaymentOrder.userId` foreign key.

### 5.7 Preventing user manipulation of credit/subscription state

- No client-facing endpoint mutates `creditBalance` or `CreditLedger` directly.
- The only write paths are:
  1. Webhook handler (adds credits) — requires valid HMAC signature from Razorpay.
  2. Credit guard (deducts credits) — runs server-side before expensive operations.
  3. Free-credit grant (adds credits) — runs once per user, idempotent via ledger unique constraint.
- `creditBalance` is an `Int` field with atomic `updateMany` — no client input can overflow, underflow, or race the balance.

---

## 6. Credit packages and cost policy

### 6.1 Credit packages (what users buy)

| Package ID | Credits | Price (INR) | Price (paise) |
|---|---|---|---|
| `50` | 50 | ₹99 | 9900 |
| `200` | 200 | ₹349 | 34900 |
| `500` | 500 | ₹799 | 79900 |

These are defined in `credit-cost.policy.ts` as a simple lookup object. Adding a new package is a code change (no migration needed). The `packageId` string is what the client sends in `POST /payments/order`; the server resolves the credit count and price from this table.

### 6.2 Credit cost per operation

| Operation | Credit cost | Rationale |
|---|---|---|
| Code review | 5 | Single-agent, one LLM call |
| PR review | 10 | Multi-agent: N cluster workers + synthesis — significantly more expensive |
| Chat message | 1 | Single fast-model call |

These costs are defined in the same `credit-cost.policy.ts` file. The credit guard reads them at runtime — changing costs is a code change that takes effect on next deploy.

### 6.3 Free credits on signup

**Amount:** 25 credits — enough for ~2 code reviews + ~2 PR reviews + ~5 chat messages, or ~5 code reviews.

**Mechanism:** A `FREE_GRANT` ledger entry with a unique partial index:

```sql
CREATE UNIQUE INDEX "CreditLedger_free_grant_per_user"
ON "CreditLedger" ("userId") WHERE "type" = 'FREE_GRANT';
```

This ensures the grant can only happen once per user, regardless of how many times `findOrCreate` runs. The grant logic: after `upsert`, attempt to insert a `FREE_GRANT` ledger entry + increment `creditBalance` in a `$transaction`. If the unique partial index rejects the insert, the user already has their free credits → no-op.

---

## 7. Error handling

### 7.1 Order creation failures

| Failure | Response | Recovery |
|---|---|---|
| Invalid `packageId` | `400 Bad Request` | Client shows validation error |
| Razorpay API error | `502 Bad Gateway` | Client shows "Payment service unavailable" — user retries |
| DB write failure | `500 Internal Server Error` | Razorpay order exists but local row doesn't — orphaned order expires naturally on Razorpay's side |

### 7.2 Webhook processing failures

| Failure | Response | Recovery |
|---|---|---|
| Invalid signature | `401 Unauthorized` | Razorpay retries — if secret is misconfigured, all retries fail (operator alert) |
| Unknown order (no matching `razorpayOrderId`) | `200 OK` (log warning) | Don't reject — Razorpay would retry indefinitely. The order may have been created in a different environment. |
| DB write failure in `$transaction` | `500 Internal Server Error` | Razorpay retries with exponential backoff for up to 24 hours |
| Duplicate event | `200 OK` (no-op) | Expected behavior — harmless |

### 7.3 Credit gate failures

| Failure | Response | Recovery |
|---|---|---|
| Insufficient balance | `402 Payment Required` | Client shows "Insufficient credits" with a recharge CTA |
| DB failure during decrement | `500 Internal Server Error` | No credits deducted, no review created — user retries |

### 7.4 Failed review credit refund

When a review fails after credits were deducted (status transitions to `FAILED`), a `CONSUMPTION_REFUND` ledger entry must be issued to return the credits.

**Atomicity requirement (F-05):** The refund and the `markFailed` status transition must execute in the same Prisma `$transaction` (interactive callback form). If they are separate operations, a crash between `markFailed` and `refundCredits` leaves the review as `FAILED` with no refund, and the user permanently loses credits with no recovery path (the review is terminal and the dispatcher will not retry).

```
$transaction(async (tx) => {
  Step 1: tx.review.updateMany({ where: { id: reviewId, status: 'PROCESSING' }, data: { status: 'FAILED' } })
  Step 2: If count === 0 → review already terminal, skip refund
  Step 3: tx.creditLedger.create({ type: 'CONSUMPTION_REFUND', amount: +cost, reviewId })
  Step 4: tx.user.updateMany({ where: { id: userId }, data: { creditBalance: { increment: cost } } })
  Step 5: Read tx.user.findUniqueOrThrow → balanceAfter (for ledger snapshot)
})
```

**Double-refund guard (F-05):** A unique constraint on `CreditLedger (reviewId, type = 'CONSUMPTION_REFUND')` ensures that at most one refund is issued per review. If the constraint is violated (caught as `P2002`), log at `warn` and return cleanly.

---

## 8. Frontend state synchronization

### 8.1 Credit balance display

The `AppHeader` component shows the user's current credit balance in the navigation bar. This is fetched via `GET /payments/wallet` on mount and cached in a React context (or SWR/hook state). The balance is refreshed:

1. On page navigation (via the `useWallet` hook's `useEffect`)
2. After checkout popup closes (polling loop, see §2)
3. After a review completes or fails (the review page triggers a wallet refresh)

### 8.2 Wallet polling after checkout

After the Razorpay Checkout popup fires `handler(response)`:

1. Close the popup (automatic)
2. Start polling `GET /payments/wallet` every 2 seconds
3. Compare the returned `balance` against the pre-checkout balance
4. If balance increased → show success message, stop polling
5. If 30 attempts (60 seconds) pass without change → show "Payment is being processed — your credits will appear shortly"
6. On the next page navigation, `useWallet` refetches and shows the updated balance

### 8.3 Insufficient-credits UX

When `POST /review/session` or `POST /history/:id/chat` returns `402`:

1. The existing error-handling in `apiFetch` throws with the server's message
2. The review/chat page catches the error and shows a prominent "Insufficient credits" message
3. The message includes a link to the Account page for recharging

---

## 9. Endpoint summary

| Method | Path | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| `POST` | `/payments/order` | `AuthGuard` | `UserThrottlerGuard` — 5/hr | Create Razorpay order + local `PaymentOrder` |
| `POST` | `/payments/webhook` | None (HMAC sig) | None | Receive Razorpay webhook events |
| `GET` | `/payments/wallet` | `AuthGuard` | `UserThrottlerGuard` — 60/min (F-12) | Return credit balance + recent ledger |

Rate-limiting on order creation (5/hour) is intentionally conservative — it prevents scripted abuse while allowing legitimate double-clicks (each order is a separate DB row).

**Pending order cap (F-11):** `POST /payments/order` must check the user's current count of `CREATED` orders before calling the Razorpay API. If the count is ≥ 3, reject with `429 Too Many Requests` and the message "You have too many pending orders — please complete or wait for them to expire." This prevents unbounded accumulation of abandoned orders.

**Amount cross-check in webhook (F-09):** When processing `order.paid`, verify that `payload.order.entity.amount_paid` (in paise) matches `localOrder.amountPaise`. If they differ, log a critical alert, record a `PaymentEvent` with type `order.paid.amount_mismatch`, and return `200` without granting credits. Do not crash.

---

## 10. Corrections to prior documents

No factual errors were found in `00-context.md` or `01-audit.md`. The following are clarifications rather than corrections:

1. **Audit §7 item 2 mentions `POST /payments/webhook`, `POST /payments/order`, `GET /payments/wallet`** — this architecture confirms all three endpoints with the exact semantics described.
2. **Audit §9 question #1 (webhook event subset)** — resolved in §1.1 above. The audit's candidates (`payment.captured`, `payment.failed`, `order.paid`) were correct; the final selection is `order.paid` + `payment.failed`.
3. **`00-context.md` D-14 mentions brainstorm "in `02-implementation-plan.md`"** — the brainstorm happened here in `02-architecture.md` (§1.1 and §1.2) because architectural decisions belong in the architecture document. The implementation plan (`03-implementation-plan.md`) references these decisions.

---

## Related files

| File | Role in this document |
|---|---|
| [`00-context.md`](./00-context.md) | Feature context, resolved decisions D-1 through D-14 |
| [`01-audit.md`](./01-audit.md) | Repository audit — constraints, risks, existing patterns |
| [`03-implementation-plan.md`](./03-implementation-plan.md) | Executable file-by-file plan |
| [`apps/server/prisma/schema.prisma`](../../../apps/server/prisma/schema.prisma) | Schema being extended |
| [`apps/server/src/review/review.repository.ts`](../../../apps/server/src/review/review.repository.ts) | Status-guard transition pattern reference |
| [`apps/server/src/review/review-dispatcher.service.ts`](../../../apps/server/src/review/review-dispatcher.service.ts) | `updateMany` idempotency pattern reference |
| [`apps/server/src/auth/auth.guard.ts`](../../../apps/server/src/auth/auth.guard.ts) | Auth pattern for payment endpoints |
| [`apps/server/src/health.controller.ts`](../../../apps/server/src/health.controller.ts) | Unauthenticated route precedent |
