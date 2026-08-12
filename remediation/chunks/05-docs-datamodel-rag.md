# Chunk 05 — Docs: data model & RAG

> **Status:** pending · **Findings:** A-17, A-18, A-19, A-20 (4) · **Severity mix:** 🔴2 🟠1 🟡1
> **Depends on:** chunk 00 (document the schema *with* its new indexes and baseline story) · **Gated by:** nothing
> **Files touched:** `docs/data-model.md`, `docs/rag.md`, `remediation/PROGRESS.md`. **Owns `data-model.md` exclusively — no other chunk edits it.**

## 1. Goal & why it matters

`docs/data-model.md` claims "five models" and omits the dispatch-outbox table and `DispatchStatus` enum entirely; both it and `docs/rag.md` describe a paragraph-based ~500-char chunking strategy that does not exist (reality: fixed 2,000-char sliding window, 200-char overlap). Anyone reasoning about embedding quality, storage, or the review lifecycle from these docs starts from false premises.

## 2. Context brief (ground truth)

- `apps/server/prisma/schema.prisma` — **7 models**: `User` (GitHub id as string PK), `Document`, `DocumentChunk` (`embedding Unsupported("vector(1536)")?`, `metadata Json?`), `Review` (`traceLog Json?`, `coverage Json?`, relations incl. `dispatch ReviewDispatch?`), `ReviewDispatch` (`reviewId @unique`, `status DispatchStatus`, `attempts`, `availableAt`, `lockedUntil`, `lastError`, `dispatchedAt`; `@@index([status, availableAt])`), `Issue`, `Conversation`. **3 enums**: `ReviewStatus` (PENDING/COMPLETE/PARTIAL/FAILED/CANCELLED), `ReviewType` (CODE/PR), `DispatchStatus` (PENDING/PROCESSING/DISPATCHED/FAILED/CANCELLED, `schema.prisma:61`).
- After chunk 00: add the new indexes (`Review.userId`, `Document.userId`, `Issue.reviewId`, `Conversation.reviewId`, `DocumentChunk.documentId`) to the doc, plus a line about the baseline migration (`20260301000000_baseline_core`) explaining why migration history starts there.
- Chunking (`packages/ai/src/embeddings.ts`): `chunkText(text, chunkSize = 2000, overlap = 200)` — fixed sliding window, no paragraph/newline awareness; whitespace-only tail chunks dropped. ~500 tokens/chunk at 4 chars/token.
- IDs: `DocumentChunk` rows are raw-SQL-inserted with `randomUUID()` (`apps/server/src/rag/rag.repository.ts:44`) — **UUIDs**, despite the schema's `@default(cuid())` (the default never fires on raw inserts) (A-20).
- Ingestion: `RagService` extracts text (pdf-parse dynamic import for PDFs), `embedMany` over chunks, `RagRepository.insertDocumentWithEmbeddings` = one transaction: `document.create` + per-chunk `$executeRaw` INSERT with `::vector` cast. Retrieval: cosine distance (`<=>`) top-5 per user, joined `content` with `\n\n---\n\n`, returns `appliedNames`.
- Review lifecycle for the doc: `PENDING → COMPLETE | PARTIAL | FAILED | CANCELLED`; dispatch lifecycle `PENDING → PROCESSING → DISPATCHED | FAILED | CANCELLED` (see `review-dispatcher.service.ts`; chunk 03's queue-streaming.md describes the mechanism — cross-link, don't duplicate).
- **M-9 note (record only, do not fix here):** PR-path retrieval embeds a fixed query (`'code review standards best practices'`, `review.service.ts:182`) rather than PR-derived content — add a "known limitation" line to `docs/rag.md`.

## 3. Findings covered

| ID | Sev | Finding |
|---|---|---|
| A-17 | 🔴 | rag.md/data-model.md describe ~500-char paragraph chunking on double newlines — reality is a 2,000-char window with 200-char overlap |
| A-18 | 🔴 | data-model.md says "five models" — schema has 7; `ReviewDispatch` + `Review.dispatch` relation undocumented |
| A-19 | 🟠 | Enums section lists only 2 — `DispatchStatus` exists (`schema.prisma:61`) |
| A-20 | 🟡 | DocumentChunk `id` documented as CUID — raw inserts use `randomUUID()` |

## 4. Read first

- `apps/server/prisma/schema.prisma`, `apps/server/src/rag/rag.repository.ts`, `apps/server/src/rag/rag.service.ts`, `packages/ai/src/embeddings.ts`
- `apps/server/src/review/review-dispatcher.service.ts` (for the lifecycle summary)
- Current `docs/data-model.md`, `docs/rag.md`; `AUDIT-REPORT.md` §2.4, §2.5

## 5. Tasks

1. [ ] **A-18 + A-19:** update `docs/data-model.md` — 7 models, full `ReviewDispatch` table section (columns, indexes, lifecycle), `Review.dispatch` relation, all 3 enums, and the post-chunk-00 index list + baseline-migration note. **Acceptance:** every model/enum in `schema.prisma` appears in the doc; "five models" is gone.
2. [ ] **A-17:** fix chunking in both docs — 2,000-char sliding window, 200-char overlap, no paragraph splitting, ~500 tokens, whitespace-tail drop. Remove all "paragraph"/"double newline" language. **Acceptance:** grep `rag.md` + `data-model.md` for `500`/`paragraph`/`double newline` → only correct usages remain.
3. [ ] **A-20:** document UUID (not CUID) chunk IDs and *why* (raw SQL insert bypasses the Prisma default).
4. [ ] **M-9 line:** add the fixed-query known-limitation note to `docs/rag.md`'s retrieval section.

## 6. Verification

```bash
grep -n 'five models\|~500\|paragraph\|double newline' docs/data-model.md docs/rag.md   # expect: no stale matches
grep -n 'ReviewDispatch\|DispatchStatus' docs/data-model.md                              # expect: matches
```

## 7. Guardrails

- Documentation only.
- Do not duplicate the dispatcher mechanism detail — one lifecycle summary + cross-link to `docs/queue-streaming.md`.
- Do not "fix" the RAG fixed-query behavior — record-only (M-9 sub-item).
- Check PROGRESS.md: if chunk 00 is not done yet, write the index section to match the CURRENT schema and leave a `<!-- TODO(chunk-00): add index list -->` marker.

## 8. Done checklist

- [ ] data-model.md: 7 models + 3 enums + ReviewDispatch + indexes
- [ ] rag.md + data-model.md chunking corrected
- [ ] UUID note + RAG known-limitation note added
- [ ] Grep checks pass; `PROGRESS.md` updated (4 findings)
