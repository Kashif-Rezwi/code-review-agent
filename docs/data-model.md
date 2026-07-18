# Data Model

## Overview

Code Review Agent uses a PostgreSQL database with the `pgvector` extension, managed via Prisma ORM. The schema is intentionally lean — five models covering users, coding-standard documents and their vector chunks, completed reviews with their issues, and per-review conversation history.

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
| `createdAt` | `DateTime` | Auto-set on first sign-in |
| `updatedAt` | `DateTime` | Auto-updated on every upsert |

**Lifecycle:** Created or updated (`upsert`) on every authenticated request via `AuthGuard → AuthService → UsersService.findOrCreate`. There is no explicit sign-up step.

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

**`DocumentChunk`** — one paragraph-sized text segment from a Document, with its embedding vector.

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (CUID, PK) | |
| `documentId` | `String` | FK → `Document.id` (cascade delete) |
| `content` | `String` | Raw text of the chunk |
| `embedding` | `vector(1536)?` | `pgvector` native type; null until embedded |
| `metadata` | `Json?` | Reserved for future chunk metadata |

**Lifecycle:** During ingestion, the `RagService` extracts text from a PDF/text file, splits it into ~500-character chunks, embeds all chunks in a single `embedMany` call, then persists the `Document` and all `DocumentChunk` rows atomically via `RagRepository.insertDocumentWithEmbeddings`.

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
ReviewStatus: PENDING | COMPLETE | PARTIAL | FAILED | CANCELLED
ReviewType:   CODE | PR
```

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

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma) | Authoritative schema definition |
| [`apps/server/src/prisma/`](../apps/server/src/prisma/) | `PrismaModule` and `PrismaService` (singleton client) |
| [`apps/server/src/review/review.repository.ts`](../apps/server/src/review/review.repository.ts) | Review + Issue persistence |
| [`apps/server/src/rag/rag.repository.ts`](../apps/server/src/rag/rag.repository.ts) | Document + Chunk persistence, vector search |
| [`apps/server/src/history/history.repository.ts`](../apps/server/src/history/history.repository.ts) | Review list, detail, stats, chat persistence |
