# RAG — Retrieval-Augmented Generation

## Overview

The RAG system allows users to upload their team's coding standards documents. These documents are split into chunks, embedded as vectors, and stored in Postgres via the `pgvector` extension. On every review, the most semantically relevant chunks are retrieved and injected into the AI's system prompt, biasing the review toward the team's specific rules.

The system is designed to **degrade gracefully** — if no standards are uploaded, if the database is unavailable, or if the embedding API fails, the review proceeds normally without any standards context.

---

## High-Level Design

```
Upload path
  User uploads PDF/text file
        │
        ▼
  RagController (POST /rag/upload)
        │
        ▼
  RagService.ingest()
    ├── extractText()       — PDF or plain text → raw string
    ├── chunkText()         — fixed 2,000-char windows, 200-char overlap
    ├── embedMany()         — single batched OpenAI embeddings call
    └── RagRepository.insertDocumentWithEmbeddings()
          └── Postgres: INSERT Document + n DocumentChunk rows with vector embeddings

Retrieval path (runs before every review)
  ReviewService calls RagService.retrieveForContext(query, userId)
        │
        ▼
  embed() — embed the query string
        │
        ▼
  RagRepository.querySimilarChunks()
    └── SELECT top-5 chunks by cosine distance (pgvector <=> operator)
        filtered by userId
        │
        ▼
  Returns RetrievedStandards { content: string, appliedNames: string[] }
        │
        ▼
  Injected into review system prompt as:
  "Your team's coding standards — apply these during the review:\n\n{content}"
```

---

## Components

### `RagController`

`src/rag/rag.controller.ts` exposes three endpoints:

| Method | Route | Description |
|---|---|---|
| `POST` | `/rag/upload` | Upload a document (multipart/form-data) |
| `GET` | `/rag/documents` | List user's uploaded documents |
| `DELETE` | `/rag/documents/:id` | Delete a document (cascades to all chunks) |

All endpoints require authentication via `AuthGuard`.

### `RagService`

Orchestrates ingestion and retrieval. Two primary methods:

**`ingest(buffer, mimeType, fileName, userId)`**
1. Calls `extractText()` to convert buffer to a string. For PDFs, this uses `pdf-parse` via a **dynamic `import()`** (not a static import) — `pdf-parse` has module-level side-effects that break Jest at initialisation time; dynamic import isolates them. Plain text files are decoded directly from the buffer.
2. Calls `chunkText()` from `@cra/ai` to split the text with a fixed sliding window — 2,000 characters per chunk with a 200-character overlap (no paragraph/newline awareness); whitespace-only tail chunks are dropped.
3. Calls `embedMany()` with all chunks in a single API call — far fewer round-trips than a per-chunk loop.
4. Delegates persistence to `RagRepository`.

**`retrieveForContext(queryText, userId)`**
1. Guards: if no `DATABASE_URL` is configured, returns `null` immediately (dev mode without DB).
2. Calls `embed()` to compute the query embedding.
3. Calls `RagRepository.querySimilarChunks()` for the top-5 nearest chunks.
4. Returns `{ content: string, appliedNames: string[] }` — content is all chunks joined; appliedNames is the deduplicated list of source document names.
5. Any embedding API failure returns `null` rather than throwing, preserving review availability.

### `RagRepository`

`src/rag/rag.repository.ts` handles all Postgres interactions related to RAG.

**`insertDocumentWithEmbeddings`** — runs in a transaction:
1. Inserts the `Document` record.
2. Batch-inserts all `DocumentChunk` rows with their `embedding` vectors via raw SQL (`$executeRaw` with `pgvector`'s `::vector` cast); each chunk `id` is generated with `randomUUID()` — the schema's `@default(cuid())` never fires on this raw-insert path.

**`querySimilarChunks`** — raw SQL query:
```sql
SELECT dc.content, d.name
FROM "DocumentChunk" dc
JOIN "Document" d ON dc."documentId" = d.id
WHERE d."userId" = $userId
ORDER BY dc.embedding <=> $queryEmbedding::vector
LIMIT 5
```
The `<=>` operator is pgvector's cosine distance.

### `@cra/ai` — `chunkText()`

The `embeddings.ts` module in `@cra/ai` exports `chunkText(text, chunkSize = 2000, overlap = 200): string[]`. The algorithm:
1. Walks the text with a fixed sliding window: `text.slice(start, start + 2000)`, advancing `2000 - 200 = 1800` chars per step — so consecutive chunks overlap by 200 characters. There is no paragraph, newline, or sentence awareness.
2. Drops any chunks that are purely whitespace (possible at the tail).
3. Returns the surviving windows as the chunk array (~500 tokens per chunk at ~4 chars/token).

### AI Models Used

| Operation | Model | API call |
|---|---|---|
| Document embedding | `text-embedding-3-small` | `embedMany()` |
| Query embedding | `text-embedding-3-small` | `embed()` |

Both are accessed via `AiService.embeddingModel`.

---

## System Flow — Upload

1. User uploads `eslint-standards.pdf` via the Standards page.
2. `RagController` receives the multipart form data.
3. `RagService.ingest(buffer, "application/pdf", "eslint-standards.pdf", userId)` fires.
4. `extractText` uses `pdf-parse` to extract raw text from the PDF.
5. `chunkText` produces, e.g., 12 overlapping 2,000-char chunks.
6. `embedMany` makes one API call to OpenAI, returns 12 embedding vectors.
7. `RagRepository.insertDocumentWithEmbeddings` writes one `Document` row and 12 `DocumentChunk` rows.
8. The controller returns `{ id, name, createdAt }`.

## System Flow — Retrieval

1. `ReviewService.streamAnalyzeCode(code, userId, conn, reviewId)` is called.
2. First line: `await this.ragService.retrieveForContext(code, userId)`.
3. `embed({ value: code })` computes a query vector for the user's code.
4. `querySimilarChunks` returns the 5 most relevant chunks from the user's uploaded standards.
5. The chunks are concatenated into a `content` string.
6. `buildSystemPrompt("CODE")` is augmented: `"${systemPrompt}\n\nYour team's coding standards:\n\n${standards.content}"`.
7. The augmented system prompt is passed to `streamText`.

> **Known limitation (PR path):** PR reviews embed a fixed query (`'code review standards best practices'`) instead of PR-derived content, so the retrieved standards may be less relevant to the actual diff. Only the pasted-code path embeds the code itself.

---

## Responsibilities

| Component | Owns |
|---|---|
| `RagController` | HTTP endpoints, auth guard, multipart parsing |
| `RagService` | Orchestration, error isolation, graceful degradation |
| `RagRepository` | Postgres persistence, raw SQL vector operations |
| `@cra/ai/embeddings` | Text chunking algorithm |
| `AiService` | Embedding model provider |

The `ReviewService` delegates RAG retrieval entirely to `RagService` and treats the result as optional context.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Empty document | `chunkText` produces zero chunks → `BadRequestException("Document has no readable content")` |
| PDF parse failure | `extractText` throws → propagates as server error |
| Embedding API failure | `retrieveForContext` catches, logs warning, returns `null` — review proceeds without standards |
| `DATABASE_URL` not configured | `retrieveForContext` returns `null` immediately — no DB call attempted |
| User has no uploaded standards | `querySimilarChunks` returns `null` or empty → `retrieveForContext` returns `null` |
| Concurrent upload and retrieval | Not a concern — pgvector queries are read-only; chunks are fully inserted before query can return them |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/rag/rag.controller.ts`](../apps/server/src/rag/rag.controller.ts) | HTTP interface |
| [`apps/server/src/rag/rag.service.ts`](../apps/server/src/rag/rag.service.ts) | Ingestion and retrieval orchestration |
| [`apps/server/src/rag/rag.repository.ts`](../apps/server/src/rag/rag.repository.ts) | Vector storage and cosine search |
| [`apps/server/src/rag/document-parser.util.ts`](../apps/server/src/rag/document-parser.util.ts) | PDF and text extraction |
| [`packages/ai/src/embeddings.ts`](../packages/ai/src/embeddings.ts) | `chunkText()` implementation |
| [`apps/server/src/ai/ai.service.ts`](../apps/server/src/ai/ai.service.ts) | Provides `embeddingModel` |
| [`apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma) | `Document` and `DocumentChunk` models |
