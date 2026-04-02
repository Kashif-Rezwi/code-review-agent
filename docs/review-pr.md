# PR Review Pipeline (Multi-Agent Clustered)

## Overview

The PR review pipeline is the most architecturally complex part of the system. Unlike the single-agent code review, large PRs are split into domain clusters, each reviewed independently by a parallel worker agent, and the results are synthesised by a dedicated synthesis agent. The entire orchestration emits SSE events to the frontend in real time so the user can watch each cluster's progress simultaneously.

For single-file code paste review, see [review-code.md](./review-code.md).

---

## High-Level Design

```
POST /review/session { type: "PR", input: prUrl }
        │
        ▼
ReviewController → createSession(PENDING) → enqueue(BullMQ) → return { reviewId }

BullMQ Worker
        │
        ▼
ReviewService.streamAnalyzeFromPR(prUrl, userId, conn, reviewId)
        │
        ├── Phase 1:  Fetch PR files + RAG standards (parallel)
        │               GithubService.fetchPRFiles()
        │               RagService.retrieveForContext()
        │
        ├── Phase 1b: Emit task_plan + task_updates for each file
        │
        ├── Phase 2:  planClusters(files) → 1–4 domain clusters
        │               Emit cluster_plan event
        │
        ├── Phase 3:  Run all worker agents in parallel (Promise.allSettled)
        │               Each → runWorkerAgent(cluster, standards, send)
        │               Each emits: thinking + tool_start + tool_done + cluster_done
        │
        ├── Phase 4a: If 1 cluster → skip synthesis, emit complete
        │
        └── Phase 4b: If >1 cluster → synthesizeReview() → emit complete
                        (2 LLM attempts + programmatic merge fallback)
```

---

## Phase 1 — Data Collection

Two parallel `Promise.all` branches:

**`GithubService.fetchPRFiles(prUrl)`**
Fetches the list of changed files with full per-file diffs. Paginated across multiple GitHub API pages. Each file returned as a `PRFile` with `filename`, `additions`, `deletions`, `status`, and `patch`.

If `fetchPRFiles` returns zero files (network failure, empty PR, etc.), the pipeline **falls back to the single-agent path** using `fetchPRDiff` (the full unified diff) as input to `streamAnalysis`.

**`RagService.retrieveForContext(...)`**
Retrieves the user's coding standards from pgvector. Returns `null` if none are uploaded or if retrieval fails — RAG is always optional.

**Phase 1b — file task events:**
Before clustering, the UI is told which files exist:
- `task_plan` event with all filenames → UI shows "Reading files…" stage
- `task_update` events for each file (status=done, with diff stats) → files light up as read

---

## Phase 2 — Cluster Planning

`planClusters(files, openai)` from `@cra/ai`:

- **Small PRs (≤3 files):** Returns a single `"general"` cluster — no LLM call needed.
- **Larger PRs:** Calls `gpt-4o-mini` via `generateObject` with a structured Zod schema to group files into 2–4 domain clusters. Rules enforced in the prompt: related files grouped together, max 4 clusters, every file in exactly one cluster.
- **Fallback:** Any failure in `generateObject` returns the single `"general"` cluster covering all files.

The `cluster_plan` event is emitted immediately after planning. The frontend renders cluster panels instantly — it doesn't wait for the workers to finish.

Each `ClusterPlan` carries: `id`, `label`, `focus` (1–2 sentence review instruction), and the full `PRFile[]` array.

---

## Phase 3 — Parallel Worker Agents

`Promise.allSettled` runs all worker agents concurrently. A failure in one cluster never blocks the others.

### `runWorkerAgent(cluster, standards, send)`

Each worker is a self-contained `streamText` loop:

1. **Context construction:** All file diffs for that cluster are formatted as a fenced block. Patches > 3,000 characters are truncated with a `[diff truncated]` notice to keep token budgets reasonable.
2. **User message:** `"Review the following files…\nYour focus: {cluster.focus}\n\n{fileSection}"`
3. **System prompt:** `buildWorkerPrompt(cluster.label, cluster.focus, standards?.content)` from `@cra/ai` — a specialised prompt that focuses the agent on the cluster's domain.
4. **Tools:** Only `runLinter` — GitHub file-fetch tools are not needed (diffs are pre-loaded in context).
5. **Agent loop:** Same `stopWhen` / `prepareStep` pattern as the code review pipeline (`AGENT_MAX_STEPS.WORKER = 5`).
6. **Event tagging:** Every event emitted by a worker is tagged with `clusterId` so the frontend can route it to the correct cluster panel.
7. **Completion:** On success, emits `cluster_done { clusterId, issueCount, durationMs }` and returns the parsed `ReviewData`.

---

## Phase 4a — Single-Cluster Shortcut

If `planClusters` returned exactly one cluster (small PR or fallback), the worker's result is the final review. No synthesis step needed. The single worker's `ReviewData` is merged with `appliedStandards`, and a `complete` event is emitted directly.

---

## Phase 4b — Synthesis Agent

`synthesizeReview(prUrl, partialReviews, standards)` merges N cluster reviews into one coherent final review.

**Attempt 1 (temperature 0.2):**
`generateText` with `buildSynthesisSystemPrompt()` and `buildSynthesisUserMessage(prUrl, partialReviews)`. The user message contains all worker reviews as structured JSON. Output is parsed via `parseReviewText`.

**Attempt 2 (temperature 0, reinforced instruction):**
If attempt 1 fails to parse (prose wrapping around JSON), a second call with a `FINAL INSTRUCTION: Your entire response must be ONE JSON object` suffix and `temperature: 0` is made.

**Programmatic fallback (guaranteed):**
If both LLM calls fail to produce valid JSON, `mergeReviewsFallback` runs deterministically:
- Deduplicates issues by `type:title:location` composite key
- Deduplicates positives via `Set`
- Averages scores across clusters
- Concatenates summaries as `"{clusterLabel}: {summary}"` joined with ` · ` (capped at 400 chars)

The fallback always produces a valid `ReviewData` — the user never sees a failure from synthesis.

---

## System Prompt Architecture

Three different prompts are used:

| Prompt | Function | File |
|---|---|---|
| `buildSystemPrompt("PR_STREAM")` | Fallback single-agent path (no tools; diffs pre-loaded) | `review.prompt.ts` |
| `buildWorkerPrompt(label, focus, standards)` | Per-cluster worker agent | `worker.prompt.ts` |
| `buildSynthesisSystemPrompt()` | Synthesis agent | `synthesis.prompt.ts` |

Worker prompts include the cluster label and focus instruction so the agent's review stays within its assigned domain.

---

## Streaming Events Emitted

| Event | Emitted by | `clusterId`? |
|---|---|---|
| `start` | Orchestrator | No |
| `task_plan` | Orchestrator (Phase 1b) | No |
| `task_update` | Orchestrator (Phase 1b) | No |
| `cluster_plan` | Orchestrator (Phase 2) | No |
| `thinking` | Worker agent | Yes |
| `tool_start` | Worker agent | Yes |
| `tool_done` | Worker agent | Yes |
| `cluster_done` | Worker agent | Yes |
| `complete` | Orchestrator (Phase 4a/4b) | No |
| `error` | Orchestrator | No |

The `clusterId` field on worker events lets the frontend route each event to the correct cluster panel without a separate channel per cluster.

---

## Responsibilities

| Component | Owns |
|---|---|
| `streamAnalyzeFromPR` | Overall orchestration, phase transitions, error recovery |
| `planClusters` | File grouping strategy, LLM cluster planning |
| `runWorkerAgent` | Per-cluster agentic loop, diff context construction |
| `synthesizeReview` | Multi-attempt LLM synthesis + programmatic fallback |
| `GithubService` | PR file fetching |
| `RagService` | Standards retrieval |

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| `fetchPRFiles` returns empty | Falls back to single-agent path with `fetchPRDiff` |
| `planClusters` LLM call fails | Returns single general cluster; pipeline continues |
| One worker agent fails | `Promise.allSettled` captures the failure; other clusters continue; failed cluster excluded from synthesis |
| All worker agents fail | `{ type: "error" }` emitted; review marked `FAILED` |
| Synthesis LLM fails twice | Programmatic `mergeReviewsFallback` always succeeds |
| PR has only 1–3 files | Single cluster; synthesis skipped |
| PR diff > 24,000 characters | Diff truncated by `GithubService.fetchPRDiff` with notice |
| Worker diff > 3,000 characters | Per-file diff truncated with `[diff truncated]` in `runWorkerAgent` |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/review/review.service.ts`](../apps/server/src/review/review.service.ts) | `streamAnalyzeFromPR`, `runWorkerAgent`, `synthesizeReview`, `mergeReviewsFallback` |
| [`packages/ai/src/clustering.ts`](../packages/ai/src/clustering.ts) | `planClusters` — LLM file grouping |
| [`packages/ai/src/prompts/worker.prompt.ts`](../packages/ai/src/prompts/worker.prompt.ts) | Worker agent system prompt |
| [`packages/ai/src/prompts/synthesis.prompt.ts`](../packages/ai/src/prompts/synthesis.prompt.ts) | Synthesis agent system prompt + user message builder |
| [`packages/ai/src/prompts/review.prompt.ts`](../packages/ai/src/prompts/review.prompt.ts) | `buildSystemPrompt("PR_STREAM")` — fallback single-agent path |
| [`packages/ai/src/tools/github.tool.ts`](../packages/ai/src/tools/github.tool.ts) | `PRFile` type, `PRFileSchema` |
| [`apps/server/src/review/review-parser.util.ts`](../apps/server/src/review/review-parser.util.ts) | JSON extraction and Zod validation |
| [`apps/server/src/review/review.repository.ts`](../apps/server/src/review/review.repository.ts) | Postgres persistence |
