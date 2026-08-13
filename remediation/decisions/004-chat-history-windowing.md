# 004 — Chat history windowing stays unimplemented (known debt)

- **Status:** Accepted (documented, 2026-08-12)
- **Audit finding:** S-10

## Context

`HistoryService.chatGenerator` sends the **full** conversation history on every
chat request — no windowing or truncation — so token cost grows unbounded with
thread length. Related: `saveChatQuery` intentionally swallows persistence
failures (chat availability over durability).

## Options

- **(a)** Cap conversation context (last N turns + token estimate).
- **(b)** Document as known debt.

## Decision

**(b) document as known debt.** Chat threads in practice are a handful of
follow-ups; the cost curve is theoretical at current usage, and windowing adds
prompt-quality trade-offs (the model loses earlier issue discussion). The
behavior is already disclosed in `docs/history-chat.md` ("no windowing —
could become expensive for very long threads").

## Consequences

- No code change.
- Revisit trigger: observed long threads, or chat cost becoming material
  against the review budget.

## Links

- `apps/server/src/history/history.service.ts`, `docs/history-chat.md`
