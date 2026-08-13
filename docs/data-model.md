# Data Model

## Overview

Code Review Agent uses a PostgreSQL database with the `pgvector` extension, managed via Prisma ORM. The schema is intentionally lean — seven models covering users, coding-standard documents and their vector chunks, reviews with their issues, a dispatch outbox, and per-review conversation history.

---

## Models

### `User`

Stores every authenticated user. The primary key is the GitHub **numeric user ID** cast to a string (e.g. `"12345678"`), not a generated UUID. This is stable across renames and used as the foreign key by all other user-owned records.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (PK) | GitHub numeric user ID as string |
| `login` | `String` (unique) | GitHub username, e.g. `"kashifrezwi"` |
| `name` | `String?` | Display name (may be null) |
| `email` | `String?` | GitHub email (may be null if private) |
| `avatarUrl` | `String?` | GitHub avatar URL |
| `creditBalance` | `Int` (default `0`) | Prepaid credit balance for reviews and chat |
| `createdAt` | `DateTime` | Auto-set on first sign-in |
| `updatedAt` | `DateTime` | Auto-updated on every upsert |

**Lifecycle:** Created or updated (`upsert`) on every authenticated request via `AuthGuard → AuthService → UsersService.findOrCreate`. Upon initial creation, `grantFreeCredits` idempotently adds 25 free credits to `creditBalance` and records a `FREE_GRANT` ledger entry.

---

### `PaymentOrder`

Tracks checkout sessions created with Razorpay.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | Internal order ID (receipt) |
| `userId` | `String` | FK → `User.id` |
| `razorpayOrderId` | `String` (unique) | Razorpay order ID (e.g. `order_xyz`) |
| `razorpayPaymentId` | `String?` | Set upon `CAPTURED` transition |
| `packageId` | `String` | Credit pack ID (`"50"`, `"200"`, `"500"`) |
| `amountPaise` | `Int` | Integer amount in paise (e.g. `9900` = ₹99) |
| `currency` | `String` (default `"INR"`) | Currency code |
| `creditsGranted` | `Int` (default `0`) | Credits awarded on capture |
| `status` | `OrderStatus` | `CREATED`, `CAPTURED`, `FAILED`, `EXPIRED` |
| `createdAt` | `DateTime` | Order creation timestamp |
| `updatedAt` | `DateTime` | Auto-updated timestamp |

---

### `PaymentEvent`

Raw webhook audit log and primary idempotency key store.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | Event record ID |
| `razorpayEventId` | `String` (unique) | `x-razorpay-event-id` header (idempotency key) |
| `razorpayOrderId` | `String?` | FK → `PaymentOrder.razorpayOrderId` |
| `eventType` | `String` | `order.paid`, `payment.failed`, `order.paid.amount_mismatch` |
| `payload` | `Json` | Raw Razorpay webhook payload |
| `processedAt` | `DateTime` | Processing timestamp |

---

### `CreditLedger`

Append-only transaction ledger for credit audit and balance tracking.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | Ledger entry ID |
| `userId` | `String` | FK → `User.id` |
| `type` | `LedgerEntryType` | `FREE_GRANT`, `PURCHASE`, `CONSUMPTION`, `CONSUMPTION_REFUND` |
| `amount` | `Int` | Positive (credits in), negative (credits out) |
| `balanceAfter` | `Int` | DB snapshot of `User.creditBalance` after entry |
| `orderId` | `String?` | Set for `PURCHASE` entries |
| `reviewId` | `String?` | Set for `CONSUMPTION` and `CONSUMPTION_REFUND` entries |
| `description` | `String?` | Human-readable note |
| `createdAt` | `DateTime` | Entry creation timestamp |

---

### `Document` + `DocumentChunk`

These two models implement the RAG (Retrieval-Augmented Generation) layer for custom coding standards.

**`Document`** — the logical document (one upload = one Document row).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | |
| `userId` | `String` | GitHub user ID (foreign-keyed implicitly) |
| `name` | `String` | Original filename |
| `chunks` | `DocumentChunk[]` | Cascade-deletes on Document delete |
| `createdAt` | `DateTime` | |

**`DocumentChunk`** — one fixed-window text segment from a Document (2,000 chars, 200-char overlap), with its embedding vector.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (UUID, PK) | `randomUUID()` on raw-SQL inserts — the `@default(cuid())` never fires on that path |
| `documentId` | `String` | FK → `Document.id` (cascade delete) |
| `content` | `String` | Raw text of the chunk |
| `embedding` | `vector(1536)?` | `pgvector` native type; null until embedded |
| `metadata` | `Json?` | Reserved for future chunk metadata |

**Lifecycle:** During ingestion, the `RagService` extracts text from a PDF/text/Markdown file, splits it into overlapping 2,000-character chunks (200-char overlap), embeds all chunks in a single `embedMany` call, then persists the `Document` and all `DocumentChunk` rows atomically via `RagRepository.insertDocumentWithEmbeddings`.

---

### `Review`

The central model — one row per review session, regardless of type (code paste or PR).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | Also used as the BullMQ job ID |
| `userId` | `String` | GitHub user ID |
| `type` | `ReviewType` | `CODE` or `PR` |
| `status` | `ReviewStatus` | Atomic `PENDING` → terminal transition |
| `input` | `String` (Text) | Raw code or PR URL exactly as submitted |
| `summary` | `String?` (Text) | Null until AI pipeline completes |
| `score` | `Int?` | Null until AI pipeline completes (1–10) |
| `positives` | `String[]` | Array of genuine strengths (default `[]`) |
| `appliedStandards` | `String[]` | Names of RAG standard docs injected (default `[]`) |
| `traceLog` | `Json?` | Full ordered array of `ReviewStreamEvent` for replay |
| `coverage` | `Json?` | Optional PR acquisition/worker coverage; null for code and legacy reviews |
| `issues` | `Issue[]` | Cascade-deletes |
| `conversations` | `Conversation[]` | Cascade-deletes |
| `dispatch` | `ReviewDispatch?` | 1:1 dispatch-outbox row (below) |
| `createdAt` | `DateTime` | |

**Status transitions:**

```
PENDING  ──► COMPLETE   (all planned worker clusters succeeded)
         ├─► PARTIAL    (some clusters succeeded and some failed)
         ├─► FAILED     (no usable result)
         └─► CANCELLED  (user cancellation won the terminal transition)
```

The `traceLog` column stores the complete `ReviewStreamEvent[]` array recorded during streaming. It enables the history view to replay a finished review exactly as it was streamed, even after the Redis TTL has expired.

---

### `ReviewDispatch`

The dispatch **outbox** — one row per review, written in the same transaction as the `Review` row, so a crash between "accept HTTP request" and "enqueue job" can never strand work. `ReviewDispatcherService` polls this table to hand work to BullMQ; see [queue-streaming.md](./queue-streaming.md) for the full mechanism.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | |
| `reviewId` | `String` (unique) | FK → `Review.id` (cascade delete) |
| `status` | `DispatchStatus` | See lifecycle below |
| `attempts` | `Int` | Dispatch attempts so far (max 6, backoff 1s→16s) |
| `availableAt` | `DateTime` | Backoff gate — rows become claimable once due |
| `lockedUntil` | `DateTime?` | 30-second claim lease |
| `lastError` | `String?` (Text) | Last dispatch failure message |
| `dispatchedAt` | `DateTime?` | Set once the BullMQ enqueue succeeded |
| `createdAt` / `updatedAt` | `DateTime` | |

**Status transitions:**

```
PENDING  ──► PROCESSING  (claimed by the dispatcher, 30s lease)
         ├─► DISPATCHED  (BullMQ enqueue succeeded)
         ├─► PENDING     (enqueue failed — backoff then retry, up to 6 attempts)
         ├─► FAILED      (attempts exhausted, or the review left PENDING)
         └─► CANCELLED   (review was cancelled before dispatch)
```

Indexes: unique on `reviewId`; `@@index([status, availableAt])` backs the poll query. See the Indexes section below.

---

### `Issue`

Each issue identified by the AI during the review.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | |
| `reviewId` | `String` | FK → `Review.id` (cascade delete) |
| `type` | `String` | `bug`, `security`, `performance`, `style`, `suggestion` |
| `severity` | `String` | `critical`, `warning`, `info` |
| `title` | `String` | Short issue title (max ~10 words) |
| `location` | `String` | File path and line, e.g. `src/auth.ts Line 23` |
| `description` | `String` (Text) | Full explanation of the problem |
| `recommendation` | `String` (Text) | How to fix it |

---

### `Conversation`

Persists the multi-turn follow-up chat for each review.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | |
| `reviewId` | `String` | FK → `Review.id` (cascade delete) |
| `role` | `String` | `"user"` or `"assistant"` |
| `content` | `String` (Text) | Full message text |
| `createdAt` | `DateTime` | Preserves message ordering |

**Lifecycle:** One row per message turn. Appended by `HistoryRepository.saveChatQuery`, which writes both the user message and the assistant response in a single transaction once the AI stream completes.

---

## Enums

```
ReviewStatus:   PENDING | COMPLETE | PARTIAL | FAILED | CANCELLED
ReviewType:     CODE | PR
DispatchStatus: PENDING | PROCESSING | DISPATCHED | FAILED | CANCELLED
```

---

## Indexes

Beyond primary keys and the `User.login` unique constraint:

| Index | Columns | Why |
|---|---|---|
| `Review_userId_idx` | `Review.userId` | Every history list/stats query filters by user |
| `Issue_reviewId_idx` | `Issue.reviewId` | Review-detail joins |
| `Conversation_reviewId_idx` | `Conversation.reviewId` | Review-detail joins |
| `Document_userId_idx` | `Document.userId` | Per-user document listing |
| `DocumentChunk_documentId_idx` | `DocumentChunk.documentId` | Join + cascade-delete lookups |
| `ReviewDispatch_reviewId_key` (unique) | `ReviewDispatch.reviewId` | 1:1 outbox row per review |
| `ReviewDispatch_status_availableAt_idx` | `ReviewDispatch(status, availableAt)` | Dispatcher poll query |

---

## Migrations

Migration history starts at `20260301000000_baseline_core`, a baseline creating the core tables/enums (`User`, `Review`, `Issue`, `Conversation`, `ReviewStatus`, `ReviewType`) plus the `pgvector` extension. It was prepended after the fact — the original databases were provisioned out-of-band via `prisma db push`, so no migration previously created those tables and a fresh `prisma migrate deploy` failed. The baseline makes empty-database deploys work; pre-existing databases mark it applied once via `prisma migrate resolve --applied 20260301000000_baseline_core`.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| GitHub user ID as primary key | Stable across username changes; avoids an extra join layer |
| `traceLog` as a JSON column | Allows full review replay from Postgres alone, without Redis history. Simple column append — no separate event-sourcing table needed |
| `coverage` as nullable JSON | Adds PR file/cluster coverage without invalidating code reviews or historical rows |
| `pgvector` extension natively in Postgres | Keeps the stack to one database; no separate vector store service required |
| Cascade deletes everywhere | Deleting a `Document` removes all its chunks; deleting a `Review` removes all issues and conversations. No orphan rows possible |
| `summary` and `score` nullable | Both are null until the AI pipeline completes, so the DB row can be created before the job runs (PENDING state) |
| Dispatch outbox (`ReviewDispatch`) | Written atomically with the review, so review creation never blocks on Redis/BullMQ and a crash between HTTP and enqueue is reconciled by the dispatcher |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma) | Authoritative schema definition |
| [`apps/server/src/prisma/`](../apps/server/src/prisma/) | `PrismaModule` and `PrismaService` (singleton client) |
| [`apps/server/src/review/review.repository.ts`](../apps/server/src/review/review.repository.ts) | Review + Issue persistence |
| [`apps/server/src/rag/rag.repository.ts`](../apps/server/src/rag/rag.repository.ts) | Document + Chunk persistence, vector search |
| [`apps/server/src/history/history.repository.ts`](../apps/server/src/history/history.repository.ts) | Review list, detail, stats, chat persistence |
