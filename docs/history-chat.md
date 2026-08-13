# History & Chat

## Overview

The History system persists all completed reviews and exposes them for replay and navigation. The Chat system allows users to ask follow-up questions about any completed review in a persistent, context-aware, streamed conversation. Both systems are served by the `HistoryModule` and consumed by the client via the `/history` and `/review/:type/:id` pages.

---

## High-Level Design

```
HistoryController (src/history/history.controller.ts)
  GET  /history              → list all reviews for the user (summary view)
  GET  /history/stats        → aggregate stats (total reviews, issue counts)
  GET  /history/:id          → full review detail
  DELETE /history/:id        → delete a review (204; ownership-checked)
  POST /history/:id/chat     → send a message; returns SSE stream of { type:"delta"|"done"|"error" }

ReviewController (src/review/review.controller.ts)
  GET  /review/:reviewId     → full review detail (proxy to HistoryService.getReview)
```

---

## Components

### `HistoryController`

`src/history/history.controller.ts` — all endpoints require `AuthGuard`.

| Method | Route | Description |
|---|---|---|
| `GET` | `/history` | List the authenticated user's reviews (**only `COMPLETE`/`PARTIAL` status** — in-progress/failed/cancelled reviews are excluded) |
| `GET` | `/history/stats` | Aggregate stats for the dashboard |
| `GET` | `/history/:id` | Full review detail |
| `DELETE` | `/history/:id` | Delete a review — 204 on success, 404 when missing or owned by another user |
| `POST` | `/history/:id/chat` | Send a chat message; returns SSE stream of events |

The chat endpoint is decorated with `@Sse()` and returns an `Observable<MessageEvent>`. Each token is emitted as `{ data: { type: 'delta', text: chunk } }`. A `{ data: { type: 'done' } }` event is sent when the stream completes, or `{ data: { type: 'error', message } }` on failure.

### `HistoryService`

`src/history/history.service.ts` owns:

**`listReviews(userId)`** → delegates to repository; returns review summaries (no issues or conversations).

**`getReview(id, userId)`** → fetches the full review with all issues and conversations. Throws `NotFoundException` if the ID doesn't exist or belongs to a different user.

**`getStats(userId)`** → aggregates review counts and issue breakdowns.

**`chatGenerator(id, userId, message)`** — the primary complexity:
1. Calls `getReview` — validates ownership and loads the review with issues and conversation history.
2. Builds the chat system prompt from the review context.
3. Maps existing `Conversation` rows to `{ role, content }` pairs for the message history.
4. Calls `streamText({ model, system, messages: [...history, newMessage] })`.
5. Yields each text delta from `result.textStream` via `for await`.
6. After the stream completes naturally, calls `historyRepository.saveChatQuery(id, userMessage, fullText)` to persist both turns.

**`buildChatSystem(review)`** — constructs the system prompt with the following sections:

```
You are a helpful code review assistant...

ORIGINAL CODE / PR URL: {input} [truncated to 2,000 chars]

REVIEW SUMMARY: {review.summary}
SCORE: {review.score}/10

ISSUES FOUND:
- [severity] title at location: description
  ... one line per issue, or "No issues found."

Answer the user's questions... Be concise and specific. Do not re-state the full review unless asked.
```

Note: only issues are included in the context (not positives). The `score` shows as `-` if the review is not yet complete.

### `HistoryRepository`

`src/history/history.repository.ts` — all Prisma queries.

**`listReviews(userId)`** — `findMany` ordered by `createdAt desc`, selecting only summary fields (no issues, no conversations, no traceLog — keeps the list fast).

**`getReview(id, userId)`** — `findFirst` with `where: { id, userId }`, includes `issues` (ordered by severity) and `conversations` (ordered by `createdAt asc`).

**`getStats(userId)`** — raw aggregations:
- Count of completed reviews
- Count of issues by type (`bug`, `security`, `performance`, etc.)
- Count of issues by severity (`critical`, `warning`, `info`)

**`saveChatQuery(reviewId, userMessage, assistantMessage)`** — creates two `Conversation` rows in a single `createMany` call (user turn + assistant turn), preserving ordering via `createdAt`.

---

## History Page — Replay

When a user opens a past review from the `/history` page:
1. The client navigates to `/review/{type}/{reviewId}`.
2. `ReviewPageClient` receives `initialReviewId`.
3. `useReviewStream(initialReviewId)` fires two requests:
   - `GET /review/:id` — fetches `sessionData` (type + input) to populate the editor/URL field.
   - `GET /review/:id/stream` — the SSE stream.
4. `ReviewStreamerService` replays the `traceLog` from Redis (if within 1 hour) or synthesises a minimal `complete` event from the DB record.
5. The reducer transitions to `phase: "complete"` after replaying.
6. The review panel and chat input render immediately.

This means history replay is visually identical to a live review — the same progress UI replays in order.

---

## Chat Flow

```
User types message → ChatInput component
        │
        ▼
useChatMessages.submit()
  ├── optimistic user message added to messages[]
  ├── setStreamingContent('') — triggers streaming cursor
  └── POST /history/:reviewId/chat { message }
            │
            ▼
      HistoryController.chat()   (@Sse() Observable<MessageEvent>)
        └── chatGenerator() async generator
              ├── { type: 'delta', text: chunk }  ← one per LLM token
              └── { type: 'done' }                ← stream complete
            │
            ▼
      consumeSSEStream<ChatStreamEvent>(reader, handler)
        ├── 'delta' → accumulated += text; setStreamingContent(accumulated)
        └── 'done'  → fall through; stream reader closes
            │
            ▼
      setMessages([...prev, { role: 'assistant', content: accumulated }])
      setStreamingContent(null)
```

**Token management:** The system prompt caps the original code at 2,000 characters. The issue list is formatted as a flat text list. The full conversation history (all prior turns) is passed on every request — no windowing or truncation.

---

## Responsibilities

| Component | Owns |
|---|---|
| `HistoryController` | HTTP routing, auth, response streaming |
| `HistoryService` | Business logic, chat system prompt, stream orchestration |
| `HistoryRepository` | All Postgres queries (list, detail, stats, conversation persistence) |
| `useChatMessages` (client) | Chat state management, streaming message accumulation |

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| `getReview` with wrong userId | `NotFoundException` — prevents cross-user data access |
| Chat on a PENDING/FAILED review | Allowed; system prompt shows `summary: "(Not completed yet)"` |
| AI stream throws mid-chat | Error propagates to controller; client receives partial content then connection drop |
| Empty AI response | `saveChatQuery` is gated on `if (fullText)` — no empty rows persisted |
| Concurrent chat messages from same user | Not currently prevented; each runs independently; conversation history may interleave |
| Review has no issues | System prompt renders "No issues found." in the issue list |
| Long conversation history | Full history sent on every request; no windowing — could become expensive for very long threads |

---

## Client Components

| Component | File | Role |
|---|---|---|
| `HistoryReviewList` | `components/history/history-review-list.tsx` | Renders the paginated review list with score badges and status indicators |
| `HistoryStatsPanel` | `components/history/history-stats-panel.tsx` | Renders aggregate stats (total reviews and issue breakdown) |
| `ChatThread` | `components/review/chat-thread.tsx` | Renders all messages with streaming cursor |
| `ChatInput` | `components/review/chat-input.tsx` | Sticky bottom input with scroll-to-review and scroll-to-latest controls |
| `useChatMessages` | `lib/use-chat-messages.ts` | Hook: manages messages, streaming state, send logic |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/history/history.controller.ts`](../apps/server/src/history/history.controller.ts) | HTTP endpoints |
| [`apps/server/src/history/history.service.ts`](../apps/server/src/history/history.service.ts) | Chat generator, system prompt builder |
| [`apps/server/src/history/history.repository.ts`](../apps/server/src/history/history.repository.ts) | All Prisma queries |
| [`apps/client/lib/use-chat-messages.ts`](../apps/client/lib/use-chat-messages.ts) | Client chat hook |
| [`apps/client/app/history/page.tsx`](../apps/client/app/history/page.tsx) | History page |
