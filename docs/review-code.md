# Code Review Pipeline (Single-Agent)

## Overview

The code review pipeline for pasted code submissions is a **single-agent agentic loop** powered by Vercel AI SDK's `streamText`. The agent can call an in-process ESLint linter as a tool, thinks in plain text (displayed to the user as live progress), and ultimately outputs a structured JSON review that is parsed, persisted, and emitted to the client.

For PR reviews, see [review-pr.md](./review-pr.md) — a different, multi-agent path.

---

## High-Level Design

```
User submits code snippet
        │
        ▼
ReviewController.createSession()
  └── creates Review row (PENDING)
  └── enqueues BullMQ job { reviewId, type: "CODE", input: code }
  └── returns { reviewId }

BullMQ picks up job
        │
        ▼
ReviewProcessor.process(job)
  └── createRedisEmitter(reviewId) → conn
  └── ReviewService.runForQueue("CODE", code, userId, conn)
        │
        ▼
ReviewService.streamAnalyzeCode(code, userId, conn, reviewId)
  ├── RagService.retrieveForContext(code, userId)  ← parallel with pipeline start
  └── streamAnalysis(userMessage, standards, code, "CODE", userId, conn, reviewId)
        │
        ▼
Vercel AI SDK streamText()
  ├── Model: poolside/laguna-s-2.1-free (temperature 0.2)
  ├── System: expert code reviewer prompt + optional RAG standards
  ├── Tool: runLinter (ESLint in-process)
  ├── stopWhen: parseReviewText() succeeds OR step limit reached
  └── prepareStep: force toolChoice=none on last step
        │
        ├── Agent loop step 1: calls runLinter(code)
        │     ├── emit tool_start event
        │     ├── ESLint runs in-process
        │     └── emit tool_done event
        │
        ├── Agent loop step 2: writes analysis + JSON
        │     └── emit thinking events as text-deltas arrive
        │
        └── loop exits when JSON is parseable
              │
              ▼
parseReviewText() validates JSON against ReviewDataSchema (Zod)
              │
              ▼
emit complete event → conn.send({ type: "complete", review, durationMs, stepCount })
              │
              ▼
ReviewRepository.saveReview() → Postgres (COMPLETE status, issues, score, traceLog)
```

---

## System Prompt

Built by `buildSystemPrompt("CODE")` from `@cra/ai`. Sections:

1. **Role** — "expert senior software engineer performing a thorough, autonomous code review"
2. **Workflow** — Step 1: write running plain-text analysis (shown to user live). Step 2: output structured JSON.
3. **Tools** — `runLinter`: Run static linter on JavaScript/TypeScript. Always called first for pasted code.
4. **JSON format** — exact schema with field descriptions, scoring guide (1–10), and severity guide.

If RAG standards were retrieved, they are appended to the system prompt:
```
Your team's coding standards — apply these during the review:

{standards.content}
```

---

## Agent Loop

The loop is controlled by two `streamText` callbacks:

**`stopWhen`**: Called after each step. Tries `parseReviewText(lastStepText)` — if it parses successfully the loop exits early. Falls back to the step limit (`AGENT_MAX_STEPS.CODE = 10`).

**`prepareStep`**: On the second-to-last step, forces `toolChoice: "none"` so the model cannot call tools on the final step and must produce text (the JSON review).

This avoids infinite loops while still allowing the model to call the linter multiple times if needed.

---

## Streaming Events Emitted

| Event | When | Carries |
|---|---|---|
| `start` | Pipeline begins | — |
| `thinking` | Text delta arrives from model | Accumulated text chunk |
| `tool_start` | `runLinter` call detected | Tool name, callId, label, detail |
| `tool_done` | Linter result returned | callId, label, detail, durationMs |
| `complete` | JSON parsed successfully | Full `ReviewData`, durationMs, stepCount |
| `error` | Pipeline fails at any point | Error message string |

**`ThinkingStream`**: The `review.thinking.ts` module buffers text deltas and emits them as batched `thinking` events. It distinguishes between reasoning prose (emitted) and the final JSON block (suppressed — the JSON is parsed internally, not shown raw to the user).

---

## The `runLinter` Tool

Defined in `@cra/ai/tools/linter.tool.ts`. Input: `{ code: string, language: "javascript" | "typescript", filename?: string }`. The tool implementation calls `LinterService.lint(code, language)`.

`LinterService` uses ESLint's programmatic API (`new Linter()`, flat-config `languageOptions`) in-process — no subprocess, no config file. Rules checked:

| Rule | Level |
|---|---|
| `no-unused-vars` | warn |
| `no-undef` | error |
| `eqeqeq` | error |
| `no-eval` / `no-implied-eval` / `no-new-func` / `no-script-url` | error |
| `no-var` | warn |
| `prefer-const` | warn |
| `no-duplicate-imports` | error |

Output is capped at 20 messages to avoid blowing the context window.

Return contract: `lint()` resolves to a structured `LintResult { output, errors, warnings, parseError }`. The model receives only `output` (plain text); the counts drive the user-visible `tool_done` label (`N issues` / `clean` / `could not parse`).

**JavaScript and TypeScript both lint today.** The `language` argument selects the parser: JavaScript uses ESLint's default espree parser, TypeScript uses `@typescript-eslint/parser` (TSX supported). Both share the same rule set, and ambient globals (`console`, `process`, `window`, …) are configured so `no-undef` only flags genuinely undefined identifiers. Genuinely unparsable input (e.g. a statement-initial generic arrow `const f = <T>(v: T) => v`, which is ambiguous in TSX mode) degrades gracefully to `parseError` with zero counts, and the agent continues the review without lint findings.

---

## Review Parsing

`parseReviewText(text)` in `review-parser.util.ts` builds several candidates and validates each against `ReviewDataSchema` (Zod) until one parses:

1. The trimmed text as-is (clean JSON — the common case).
2. The contents of a ` ```json ` markdown fence, if present.
3. Balanced-brace extraction from every line-boundary `{`, tried last-to-first — handles analysis prose before **and** after the JSON (the brace matcher skips `{`/`}` characters inside JSON string values).
4. First `{` to its balanced `}` — a final net for JSON that is not at a line boundary.

It throws only when every candidate fails validation — the caller (`stopWhen`) treats a throw as "not done yet."

After the stream ends, if parsing fails on the final step text, all previous step texts are tried in reverse order. This guards against the model briefly producing valid JSON in an intermediate step before revising it.

---

## Persistence

`ReviewRepository.saveReview(input, "CODE", merged, userId, trace, reviewId)`:
1. Updates the `Review` row: `status = COMPLETE`, `summary`, `score`, `positives`, `appliedStandards`, `traceLog`.
2. Batch-creates all `Issue` rows.

`traceLog` stores the complete `ReviewStreamEvent[]` array so the History view can replay the exact review stream from Postgres, independent of Redis.

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Model never produces valid JSON within step limit | Pipeline emits `{ type: "error" }` and marks review `FAILED` |
| Linter cannot parse code | Returns safe string; review continues without linter input |
| RAG retrieval fails | `retrieveForContext` returns `null`; review proceeds without standards |
| `streamText` throws (network, quota, etc.) | Top-level try/catch in `streamAnalysis` emits error event and calls `markFailed` |
| Code exceeds token limit | Client-side guard (8,000 token limit) blocks submission; server has no separate cap |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/review/review.service.ts`](../apps/server/src/review/review.service.ts) | `streamAnalyzeCode`, `streamAnalysis`, `buildStreamCallbacks` |
| [`apps/server/src/review/review-parser.util.ts`](../apps/server/src/review/review-parser.util.ts) | JSON extraction and Zod validation |
| [`apps/server/src/review/review.thinking.ts`](../apps/server/src/review/review.thinking.ts) | `ThinkingStream` — text delta buffering |
| [`apps/server/src/review/review.formatter.ts`](../apps/server/src/review/review.formatter.ts) | Tool event label/detail builders |
| [`apps/server/src/review/review.repository.ts`](../apps/server/src/review/review.repository.ts) | Postgres persistence |
| [`apps/server/src/linter/linter.service.ts`](../apps/server/src/linter/linter.service.ts) | In-process ESLint runner |
| [`packages/ai/src/prompts/review.prompt.ts`](../packages/ai/src/prompts/review.prompt.ts) | System prompt builder |
| [`packages/ai/src/tools/linter.tool.ts`](../packages/ai/src/tools/linter.tool.ts) | `runLinter` tool definition |
