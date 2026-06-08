# Frontend Architecture

## Overview

The client is a Next.js 16 application using the App Router. It is authentication-gated via NextAuth.js with the GitHub provider, and its core feature — the live review stream — is managed by a custom hook backed by a pure Redux-style reducer. The UI is built with Tailwind CSS, shadcn/ui primitives, and Monaco Editor for code input.

---

## App Router Structure

```
apps/client/app/
├── layout.tsx               # Root layout: font setup, SessionProvider, global CSS
├── page.tsx                 # Redirect to /review/paste_code
├── session-provider.tsx     # NextAuth SessionProvider wrapper (client component)
├── error.tsx                # Route-level error boundary
├── global-error.tsx         # Root error boundary (catches layout errors)
├── globals.css              # Global CSS: design tokens, animations, utility classes
│
├── login/
│   └── page.tsx             # "Sign in with GitHub" page (shown when unauthenticated)
│
├── review/
│   ├── page.tsx             # Redirect to /review/paste_code
│   ├── error.tsx            # Review-subtree error boundary
│   └── [reviewType]/        # "paste_code" or "github_pr"
│       ├── page.tsx         # New review (no reviewId)
│       └── [reviewId]/
│           └── page.tsx     # Existing review (with reviewId)
│
├── history/
│   ├── page.tsx             # Review history list + stats
│   └── [reviewType]/        # Filterable history by type
│       └── page.tsx
│
├── standards/
│   └── page.tsx             # Upload and manage coding standard documents
│
└── api/
    └── auth/[...nextauth]/  # NextAuth route handler
```

The `[reviewType]` segment is the string `"paste_code"` or `"github_pr"` — used to set the default mode in `ReviewPageClient` and to construct navigation URLs.

---

## Component Tree (Review Page)

```
ReviewPageClient (orchestrator)
  ├── AppHeader
  ├── ReviewHeader          ← mode toggle (code / PR) + lock state
  ├── CodeEditor            ← Monaco editor (code mode)
  │     └── EditorSkeleton  ← shown while initialReviewId loads
  ├── PrUrlInput            ← PR URL mode
  ├── ReviewActionContainer ← Submit / Clear buttons + timing info
  ├── ErrorBanner           ← shows error string if phase === "error"
  ├── ReviewProgress        ← live streaming progress
  │     ├── TraceEntries    ← thinking + tool events (single-agent path)
  │     └── ClusterPanels   ← per-cluster progress (PR path)
  ├── ReviewErrorBoundary
  │     ├── ReviewPanel     ← completed review (score, issues, positives)
  │     │     ├── ScoreRing
  │     │     ├── IssueCard × N
  │     │     └── ReviewInputDisplay
  │     └── ChatThread      ← follow-up conversation
  ├── ChatInput             ← sticky bottom input (shown when reviewId is available)
  └── <div ref={bottomRef} />  ← auto-scroll anchor
```

---

## State Management

The review page has no global state store. State is managed locally in `ReviewPageClient` via two custom hooks:

### `useReviewStream`

`lib/use-review-stream.ts` — the primary hook. Manages the entire review lifecycle.

**Returns:**

| Field | Type | Description |
|---|---|---|
| `phase` | `StreamPhase` | `idle \| connecting \| streaming \| complete \| error` |
| `taskItems` | `TaskItem[]` | File-level task list (PR file collection phase) |
| `traceEntries` | `TraceEntry[]` | Thinking + tool events (single-agent path) |
| `clusterMap` | `Map<string, ClusterState>` | Per-cluster state (PR multi-agent path) |
| `review` | `ReviewData \| null` | Final review result |
| `sessionData` | `{ type, input } \| null` | Loaded from DB when replaying a past review |
| `error` | `string \| null` | Error message |
| `totalDurationMs` | `number \| null` | Pipeline duration |
| `submit` | `(payload) => Promise<string>` | Creates a session and returns the reviewId |
| `reset` | `() => void` | Aborts any active stream and resets state |

Internally, the hook:
1. Uses `useReducer(reviewStreamReducer, initialReviewStreamState)` for all stream state.
2. Uses an `AbortController` ref to manage the fetch lifecycle.
3. When `initialReviewId` is provided (opening a past review), immediately opens the SSE stream to `GET /review/:id/stream`.
4. Calls `consumeSSEStream` from `lib/sse.ts` to parse the raw SSE byte stream into typed `ReviewStreamEvent` objects and dispatches each to the reducer.

### `reviewStreamReducer`

`lib/review-stream.reducer.ts` — a pure reducer with no side effects. Handles all 10 SSE event types and produces the next state without mutation.

Key state shapes:

```typescript
TaskItem:   { id, label, status: "pending"|"running"|"done", detail? }
TraceEntry: { kind: "tool"|"thinking", id, ... }
ClusterState: {
  id, label, focus, files[],
  traceEntries: TraceEntry[],  // cluster-specific events
  issueCount?, durationMs?, done: boolean
}
```

Worker-agent events tagged with `clusterId` are routed into the matching `ClusterState`'s `traceEntries` array, not the global `traceEntries`. This is how cluster panels render independently.

### `useChatMessages`

`lib/use-chat-messages.ts` — manages the follow-up chat. State: `messages[]`, `input`, `isSending`, `streamingContent`.

The hook posts to `POST /history/:reviewId/chat` and consumes the response as an SSE stream via `consumeSSEStream<ChatStreamEvent>`. Event types:
- `{ type: 'delta', text }` — append token to `streamingContent`
- `{ type: 'done' }` — stream closed cleanly
- `{ type: 'error', message }` — stream interrupted

Key behaviours:
- **Optimistic update** — user message is appended to `messages[]` immediately before the fetch starts
- `streamingContent` is set to `''` (empty string, not null) the moment the request is sent, to display the streaming cursor while waiting for the first token
- On stream completion, the fully accumulated text is appended to `messages[]` and `streamingContent` resets to `null`
- State is fully reset when `reviewId` changes, preventing cross-session message bleed

### `useReviewScroll`

`lib/hooks/use-review-scroll.ts` — manages auto-scroll behavior. Returns refs and helpers:
- `contentRef` — the scrollable main element
- `bottomRef` — the scroll anchor at the very bottom
- `isAtBottomRef` — tracks whether the user is at the bottom (mutable ref, not state, to avoid re-renders)
- `scrollToBottom(behavior)` — instant or smooth scroll to anchor
- `isAtBottom` — boolean state for the scroll-to-bottom button in `ChatInput`

The parent component (`ReviewPageClient`) uses multiple `useEffect` hooks to trigger scrolling: on stream start, on each new trace entry, on review completion, and on each chat token.

---

## SSE Consumption

`lib/sse.ts` exports `consumeSSEStream<T>(reader, onEvent)`:

1. Reads the `ReadableStreamDefaultReader` chunk by chunk.
2. Decodes bytes to text and splits on `\n\n` SSE delimiters.
3. For each complete SSE message, strips the `data:` prefix and `JSON.parse`s the payload.
4. Calls `onEvent(parsed)`.
5. Returns when the stream closes (server sends `complete` or `error` and closes the connection).

---

## API Client

`lib/api.ts` centralises all server communication:

- `reviewService.createSession(payload, token)` — `POST /review/session`
- `reviewService.getSession(reviewId, token)` — `GET /review/:id`
- `ragService.getDocuments(token)` — `GET /rag/documents`
- `ragService.uploadDocument(file, token)` — `POST /rag/upload` (multipart)
- `ragService.deleteDocument(id, token)` — `DELETE /rag/documents/:id`

All calls include `Authorization: Bearer <github_token>` when a token is available.

---

## Error Boundaries

Three error boundary levels:

| Boundary | File | Covers |
|---|---|---|
| Global | `app/global-error.tsx` | Root layout crashes |
| Route-level | `app/review/error.tsx` | Review subtree server errors |
| Component-level | `components/ui/error-boundary.tsx` | `ReviewPanel` + `ChatThread` (client runtime errors) |

`ReviewErrorBoundary` wraps the review panel and chat independently, so a crash in one does not unmount the other.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| `useReducer` for stream state | The `ReviewStreamEvent` discriminated union maps naturally to reducer actions; prevents scattered `useState` calls and makes state transitions explicit |
| `isAtBottomRef` as a mutable ref, not state | Avoids unnecessary re-renders on every scroll event — scroll position is checked in effects, not render logic |
| Decoupled `reviewStreamReducer` | Pure function with no hooks — trivially testable, reusable in history replay |
| Cluster events routed by `clusterId` | Enables N simultaneous cluster panels without separate hooks/state per cluster |
| `AbortController` for SSE teardown | Clean cancellation on navigation or reset; no lingering fetch connections |

---

## Related Files

| File | Role |
|---|---|
| [`apps/client/lib/use-review-stream.ts`](../apps/client/lib/use-review-stream.ts) | Primary stream hook |
| [`apps/client/lib/review-stream.reducer.ts`](../apps/client/lib/review-stream.reducer.ts) | Pure stream state reducer |
| [`apps/client/lib/use-chat-messages.ts`](../apps/client/lib/use-chat-messages.ts) | Chat hook |
| [`apps/client/lib/use-trace-replay.ts`](../apps/client/lib/use-trace-replay.ts) | Replays historical trace events for the history view |
| [`apps/client/lib/sse.ts`](../apps/client/lib/sse.ts) | Raw SSE byte stream parser — used for both review and chat streams |
| [`apps/client/lib/api.ts`](../apps/client/lib/api.ts) | Typed API client |
| [`apps/client/lib/detect-language.ts`](../apps/client/lib/detect-language.ts) | Language detection + `CODE_TOKEN_LIMIT` constant |
| [`apps/client/lib/hooks/use-review-scroll.ts`](../apps/client/lib/hooks/use-review-scroll.ts) | Auto-scroll hook |
| [`apps/client/components/review/review-page-client.tsx`](../apps/client/components/review/review-page-client.tsx) | Root orchestrator component |
| [`apps/client/components/review/review-progress.tsx`](../apps/client/components/review/review-progress.tsx) | Streaming progress UI |
| [`apps/client/components/review/trace-entries.tsx`](../apps/client/components/review/trace-entries.tsx) | Thinking + tool event renderer |
