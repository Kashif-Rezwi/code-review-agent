# History & Chat

## Overview

The History system persists all completed reviews and exposes them for replay and navigation. The Chat system allows users to ask follow-up questions about any completed review in a persistent, context-aware, streamed conversation. Both systems are served by the `HistoryModule` and consumed by the client via the `/history` and `/review/:type/:id` pages.

---

## High-Level Design

```
History
  GET /history               → list all reviews for the user (summary view)
  GET /history/stats         → aggregate stats (total reviews, avg score, issue counts)
  GET /review/:id            → full review detail (used when re-opening a past review)

Chat
  POST /history/:id/chat     → send a message, receive streamed AI response
  (client streams response via text/event-stream or chunked transfer)
```

---

## Components

### `HistoryController`

`src/history/history.controller.ts` — all endpoints require `AuthGuard`.

| Method | Route | Description |
|---|---|---|
| `GET` | `/history` | List all reviews for the authenticated user |
| `GET` | `/history/stats` | Aggregate stats for the dashboard |
| `GET` | `/history/:id` | Full review detail |
| `POST` | `/history/:id/chat` | Send a chat message; returns streamed response |

The chat endpoint uses NestJS's `@Sse()` or a streaming response via `StreamableFile`/generator. The controller calls `historyService.chatGenerator(id, userId, message)` and pipes the async generator to the HTTP response as chunked text.

### `HistoryService`

`src/history/history.service.ts` owns:

**`listReviews(userId)`** → delegates to repository; returns review summaries (no issues or conversations).

**`getReview(id, userId)`** → fetches the full review with all issues and conversations. Throws `NotFoundException` if the ID doesn't exist or belongs to a different user.

**`getStats(userId)`** → aggregates review counts, average score, issue type breakdown.

**`chatGenerator(id, userId, message)`** — the primary complexity:
1. Calls `getReview` — validates ownership and loads the review with issues and conversation history.
2. Builds the chat system prompt from the review context.
3. Maps existing `Conversation` rows to `{ role, content }` pairs for the message history.
4. Calls `streamText({ model, system, messages: [...history, newMessage] })`.
5. Yields each text delta from `result.textStream` via `for await`.
6. After the stream completes naturally, calls `historyRepository.saveChatQuery(id, userMessage, fullText)` to persist both turns.

**`buildChatSystem(review)`** — constructs the system prompt with:
- Original code/PR URL (truncated to 2,000 chars)
- Review summary and score
- Flat issue list (severity, title, location, description)

Instruction: "Be concise and specific. Do not re-state the full review unless asked."

### `HistoryRepository`

`src/history/history.repository.ts` — all Prisma queries.

**`listReviews(userId)`** — `findMany` ordered by `createdAt desc`, selecting only summary fields (no issues, no conversations, no traceLog — keeps the list fast).

**`getReview(id, userId)`** — `findFirst` with `where: { id, userId }`, includes `issues` (ordered by severity) and `conversations` (ordered by `createdAt asc`).

**`getStats(userId)`** — raw aggregations:
- Count by status
- Average score across completed reviews
- Count of issues by type (`bug`, `security`, `performance`, etc.)
- Count of reviews by type (`CODE` vs `PR`)

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
  └── POST /history/:reviewId/chat { message }
        │
        ▼
HistoryController.chat()
  └── pipes chatGenerator() as text chunks
        │
        ▼
Client receives chunks → streamingContent state
        │
        ▼
AssistantMessage renders with streaming cursor animation
        │
        ▼
Stream ends → full message appended to messages[]
              streamingContent reset to null
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
| `HistoryStatsPanel` | `components/history/history-stats-panel.tsx` | Renders aggregate stats (total reviews, avg score, issue breakdown) |
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
