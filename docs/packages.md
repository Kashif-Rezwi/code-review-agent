# Shared Packages

## Overview

The monorepo contains two shared packages consumed by both the server and (in the case of `@cra/types`) indirectly by the client. These packages encapsulate the AI contract and shared type system, ensuring the server's streaming output and the client's SSE consumer always agree at compile time.

---

## `@cra/types`

**Location:** `packages/types/`  
**Package name:** `@cra/types`  
**Single export:** `packages/types/src/index.ts`

### Purpose

Defines the shared contract between the NestJS server's SSE emitter and the Next.js client's stream consumer. Any new event type added to the server must be added here first — the TypeScript compiler will then enforce updates on both sides.

### Exports

#### `ReviewStreamEvent` (discriminated union)

The complete set of SSE event shapes. Each event has a `type` discriminant:

| `type` | Direction | Carries |
|---|---|---|
| `start` | server → client | *(nothing — signals pipeline began)* |
| `acquisition` | server → client | `source`, `fileCount`, `complete`, sanitized `warnings` |
| `thinking` | server → client | `text: string`, `clusterId?: string` |
| `task_plan` | server → client | `tasks: { id, label }[]` |
| `task_update` | server → client | `taskId`, `status`, `detail?` |
| `tool_start` | server → client | `tool`, `callId`, `label`, `detail?`, `clusterId?` |
| `tool_done` | server → client | `callId`, `label`, `detail?`, `durationMs`, `clusterId?` |
| `cluster_plan` | server → client | `clusters: { id, label, focus, files[] }[]` |
| `cluster_done` | server → client | `clusterId`, `issueCount`, `durationMs`, `attempts?` |
| `cluster_failed` | server → client | `clusterId`, `attempts`, `message`, `durationMs` |
| `synthesis_start` | server → client | successful `clusterCount` |
| `complete` | server → client | `review: ReviewData`, `durationMs`, `stepCount`, `outcome?` |
| `error` | server → client | `message: string` |

`clusterId` is present only on events emitted by worker agents in the multi-agent PR path. All single-agent events leave it `undefined`.

#### `ReviewData` / `ReviewDataSchema`

The final review output object, defined as a Zod schema:

```
ReviewData {
  summary:          string
  score:            number (1–10, rounded integer)
  issues:           ReviewIssue[]
  positives:        string[]
  appliedStandards: string[]  (added server-side, never from LLM)
  id:               string    (added server-side after DB save)
  coverage?:        ReviewCoverage (added server-side for PR reviews)
}
```

`ReviewDataSchema` is used by `parseReviewText` on the server to validate the LLM's JSON output, and by the client's type definitions.

#### `ReviewIssue` / `ReviewIssueSchema`

```
ReviewIssue {
  type:           "bug" | "security" | "performance" | "style" | "suggestion"
  severity:       "critical" | "warning" | "info"
  title:          string
  location:       string
  description:    string
  recommendation: string
}
```

### Design Notes

- `score` uses `z.coerce.number()` — coerces strings to numbers (LLMs sometimes return `"8"` instead of `8`) — and `.transform(n => Math.round(n))` to ensure an integer.
- `appliedStandards` and `id` are both `optional()` in the schema because they are added server-side after parsing — the LLM never emits them.
- The package has no runtime dependencies beyond `zod`.

---

## `@cra/ai`

**Location:** `packages/ai/`  
**Package name:** `@cra/ai`  
**Main export:** `packages/ai/src/index.ts`

### Purpose

Encapsulates all LLM-facing abstractions: system prompts, Vercel AI SDK tool definitions, cluster planning logic, and the text chunking utility. The server imports from this package; the package has no knowledge of NestJS, HTTP, or the database.

### Exports

#### Prompts

**`buildSystemPrompt(context: "CODE" | "PR" | "PR_STREAM"): string`**

Builds the system prompt for the main review agent. The `context` parameter selects which tools section to include:
- `CODE` — includes `runLinter` tool description only
- `PR` — includes all four GitHub tools
- `PR_STREAM` — includes a context note that diffs are pre-loaded (no tools)

All three variants share the same `WORKFLOW` and `JSON_FORMAT` sections.

**`buildWorkerPrompt(label: string, focus: string, standards?: string): string`**

System prompt for PR cluster worker agents. Scoped to the cluster's label and focus instruction. Optionally appends RAG standards.

**`buildSynthesisSystemPrompt(): string`**

System prompt for the synthesis agent. Instructs the model to merge N partial reviews into one coherent JSON review.

**`buildSynthesisUserMessage(prUrl: string, partialReviews: ...): string`**

Builds the user message for the synthesis agent by serialising all worker reviews as structured JSON.

#### Tools

**`createRunLinterTool(impl)`**

Creates a Vercel AI SDK tool that calls the provided `impl` function (which wires to `LinterService.lint`). Input schema: `{ code: string, language: "javascript" | "typescript" }`.

**`createFetchGithubPRTool(impl)`**

Tool for fetching the full PR unified diff. Input: `{ prUrl: string }`.

**`createListPRFilesTool(impl)`**

Tool for listing PR changed files with patches. Input: `{ prUrl: string }`. Returns `PRFile[]`.

**`createFetchFileContentTool(impl)`**

Tool for fetching a specific file's full source from the PR's head branch. Input: `{ prUrl: string, filePath: string }`.

All tool factories follow the same pattern: they accept an `impl` function and return a Zod-typed Vercel AI SDK tool object. The tool definition lives here; the implementation lives in the server's service layer. This separation means the `@cra/ai` package never depends on NestJS or ioredis.

#### `planClusters(files, model): ClusterPlan[]`

Groups PR files into exact-once domain clusters using the centrally configured model, then reconciles duplicates, omissions, and unknown names. Deterministic path/weight fallback always creates 2–4 groups for PRs larger than three files. See [review-pr.md](./review-pr.md).

#### `PRFile` / `PRFileSchema`

Zod schema for a GitHub PR file object (`filename`, `additions`, `deletions`, `status`, `patch?`). Re-exported for use in `GithubService`.

#### `chunkText(text: string): string[]`

Splits document text into paragraph-level chunks for RAG ingestion. See [rag.md](./rag.md).

#### Re-exports from `@cra/types`

The `@cra/ai` package re-exports `ReviewDataSchema`, `ReviewIssueSchema`, `ReviewData`, and `ReviewIssue` from `@cra/types` as a convenience — consumers only need one import.

---

## Build Process

Both packages must be compiled before the apps:

```bash
pnpm build:packages   # runs tsc for @cra/types then @cra/ai (order matters)
```

This is a prerequisite baked into all `dev`, `build`, and CI scripts. The compiled output lands in each package's `dist/` directory, which is what the apps import via workspace resolution.

---

## Related Files

| File | Role |
|---|---|
| [`packages/types/src/index.ts`](../packages/types/src/index.ts) | All `@cra/types` exports |
| [`packages/ai/src/index.ts`](../packages/ai/src/index.ts) | All `@cra/ai` exports |
| [`packages/ai/src/prompts/review.prompt.ts`](../packages/ai/src/prompts/review.prompt.ts) | Main review system prompt |
| [`packages/ai/src/prompts/worker.prompt.ts`](../packages/ai/src/prompts/worker.prompt.ts) | Cluster worker system prompt |
| [`packages/ai/src/prompts/synthesis.prompt.ts`](../packages/ai/src/prompts/synthesis.prompt.ts) | Synthesis system prompt + user message |
| [`packages/ai/src/tools/index.ts`](../packages/ai/src/tools/index.ts) | Tool definition re-exports |
| [`packages/ai/src/tools/github.tool.ts`](../packages/ai/src/tools/github.tool.ts) | GitHub API tool definitions + `PRFile` schema |
| [`packages/ai/src/tools/linter.tool.ts`](../packages/ai/src/tools/linter.tool.ts) | `runLinter` tool definition |
| [`packages/ai/src/clustering.ts`](../packages/ai/src/clustering.ts) | `planClusters` implementation |
| [`packages/ai/src/embeddings.ts`](../packages/ai/src/embeddings.ts) | `chunkText` implementation |
