# Clustered PR Review — Implementation Spec

> ⚠️ **HISTORICAL — superseded.** This document was the *design spec* for the
> clustered PR review architecture. The shipped implementation differs in
> important details (queue-backed pipeline with a Postgres dispatch outbox,
> Redis Streams instead of direct SSE, a bounded worker-concurrency pool,
> coverage accounting, cancellation) — the living reference is
> [`docs/review-pr.md`](docs/review-pr.md) plus the code. Kept for design
> history; **do not implement against this file.**

> **Purpose (original, 2026-07):** This document was the single source of truth
> for implementing the clustered PR review architecture.

---

## 1. What We Are Building and Why

### The Problem With the Current Approach

In `apps/server/src/review/review.service.ts`, the method
`streamAnalyzeFromPR` currently does this:

```typescript
const fileSection = files.map(f => { ... }).join('\n\n')
const userMessage =
    `Please review this GitHub pull request: ${prUrl}\n\n` +
    `The PR has ${files.length} changed file(s). ` +
    fileSection   // ← ALL files in ONE message to ONE model call
```

Every changed file is dumped into a single context window and reviewed by one
model call. This produces shallow, generic feedback because the model's
attention is split across completely unrelated concerns simultaneously — it is
thinking about JWT security AND database query efficiency AND API contract
design all at once.

### What We Are Building Instead

A **supervisor / worker** multi-agent architecture:

1. A **supervisor** (pure TypeScript, no LLM needed) inspects the file list and
   assigns files into 2–4 domain clusters using a lightweight LLM planning
   call.
2. Multiple **worker agents** run in **parallel** via `Promise.allSettled`,
   each reviewing only its assigned cluster with a domain-focused system
   prompt.
3. A **synthesis agent** receives all partial reviews once workers finish and
   produces a unified final review — including cross-cluster issues that span
   multiple domains.
4. All three phases emit **SSE events** through the single existing `res`
   object so the frontend sees real-time progress across all clusters
   simultaneously.

### Why This Is Better

| Concern | Before | After |
|---|---|---|
| Review depth | One shallow pass over everything | Deep focused pass per domain |
| Wall-clock time | Sequential (sum of all files) | Parallel (slowest cluster only) |
| Cross-cutting issues | Often missed | Explicit synthesis step finds them |
| User visibility | One trace panel | One panel per cluster, updating live |
| Failure handling | One failure = total failure | `Promise.allSettled` — one cluster fails, others continue |

---

## 2. Architecture Overview

```
streamAnalyzeFromPR()          ← entry point, unchanged signature
    │
    ├─ fetchPRFiles()           ← existing GithubService call
    │
    ├─ planClusters()           ← NEW: lightweight LLM call, ~200 tokens
    │   └─ returns ClusterPlan[]
    │
    ├─ send cluster_plan event  ← NEW SSE event type, UI renders panels
    │
    ├─ Promise.allSettled([     ← NEW: parallel execution
    │     runWorkerAgent(security, files, send)
    │     runWorkerAgent(database, files, send)
    │     runWorkerAgent(api,      files, send)
    │   ])
    │   Each worker:
    │     emit thinking events  (clusterId tagged)
    │     call tools            (runLinter only — diffs are pre-built)
    │     emit tool_start/done  (clusterId tagged)
    │     emit cluster_done
    │     return ReviewData
    │
    └─ runSynthesisAgent()      ← NEW: final LLM call, combines partials
        └─ send complete event  ← existing, unchanged
```

---

## 3. Files to Create or Modify

### New files

| File | Purpose |
|---|---|
| `packages/ai/src/clustering.ts` | `planClusters()` function — LLM-based file grouping |
| `packages/ai/src/prompts/worker.prompt.ts` | Domain-specific system prompts for each cluster type |
| `packages/ai/src/prompts/synthesis.prompt.ts` | Synthesis agent system prompt |

### Modified files

| File | What changes |
|---|---|
| `packages/types/src/index.ts` | Add `clusterId` to event types, add `cluster_plan` and `cluster_done` events |
| `packages/ai/src/index.ts` | Re-export new functions |
| `apps/server/src/review/review.service.ts` | Replace single-pass PR logic with supervisor/worker/synthesis |
| `apps/client/lib/use-review-stream.ts` | Handle new event types, build per-cluster state |
| `apps/client/components/review/review-progress.tsx` | Render multiple cluster panels instead of one trace |

### Do NOT touch

- `apps/server/src/review/review.controller.ts` — signatures unchanged
- `apps/server/src/review/review.sse.ts` — SSE infrastructure unchanged
- `apps/server/src/github/github.service.ts` — unchanged
- `apps/server/src/linter/linter.service.ts` — unchanged
- `apps/server/src/review/review.formatter.ts` — unchanged
- `apps/client/components/review/review-panel.tsx` — unchanged
- All non-PR review paths (`streamAnalyzeCode`, `analyzeCode`, `analyzeFromPR`)

---

## 4. Type Changes

### `packages/types/src/index.ts`

Add `clusterId` to the events that workers emit, and add two new event types.
The `complete` event and all non-cluster events remain unchanged.

```typescript
// ADD these two new event types to the ReviewStreamEvent union:

| {
    type: 'cluster_plan'
    clusters: {
        id: string          // e.g. "security", "database", "api", "general"
        label: string       // e.g. "Security & Auth", "Database & ORM"
        focus: string       // what this worker should focus on
        fileNames: string[] // filenames assigned to this cluster
    }[]
  }

| {
    type: 'cluster_done'
    clusterId: string
    issueCount: number
    durationMs: number
  }

// MODIFY these existing event types — add optional clusterId:

| { type: 'thinking';  clusterId?: string; text: string }
| { type: 'tool_start'; clusterId?: string; tool: string; label: string; callId: string; detail?: string }
| { type: 'tool_done';  clusterId?: string; callId: string; label: string; detail?: string; durationMs: number }
```

The `clusterId` is optional so the existing code-review path (which does not
use clusters) continues to work without modification.

---

## 5. New File: `packages/ai/src/clustering.ts`

This file contains the `planClusters` function. It makes one lightweight LLM
call to intelligently assign files to domain clusters.

```typescript
import { generateObject } from 'ai'
import { z } from 'zod'
import type { PRFile } from './tools/github.tool'

// ── Types ──────────────────────────────────────────────────────────────────

export interface ClusterPlan {
    id: string        // machine identifier, e.g. "security"
    label: string     // human label, e.g. "Security & Auth"
    focus: string     // instruction to the worker agent
    files: PRFile[]   // actual PRFile objects (not just names)
}

// ── Schema for generateObject ──────────────────────────────────────────────

const ClusterPlanSchema = z.object({
    clusters: z.array(z.object({
        id:        z.string(),
        label:     z.string(),
        focus:     z.string(),
        fileNames: z.array(z.string()),
    })).min(1).max(4),
})

// ── Main function ──────────────────────────────────────────────────────────

/**
 * Uses a lightweight LLM call to group PR files into 2-4 domain clusters.
 * Falls back to a single "general" cluster if the LLM call fails.
 *
 * @param files   The list of PRFile objects from fetchPRFiles()
 * @param openai  The createOpenAI instance from the calling service
 */
export async function planClusters(
    files: PRFile[],
    openai: ReturnType<typeof import('@ai-sdk/openai').createOpenAI>,
): Promise<ClusterPlan[]> {
    if (files.length === 0) return []

    // If the PR is very small, skip the planning LLM call entirely
    if (files.length <= 3) {
        return [{
            id: 'general',
            label: 'Code Review',
            focus: 'Review all aspects: correctness, security, performance, and style.',
            files,
        }]
    }

    const fileList = files.map(f =>
        `${f.filename} (+${f.additions} -${f.deletions}, status: ${f.status})`
    ).join('\n')

    try {
        const { object } = await generateObject({
            model: openai('gpt-4o-mini'),
            schema: ClusterPlanSchema,
            temperature: 0,
            prompt: `You are a senior engineer planning a code review.
Group the following changed files into 2-4 review clusters by domain.
Each cluster should have a clear review focus.

Rules:
- Group related files together (auth files together, DB files together, etc.)
- Maximum 4 clusters — merge related domains if there are too many
- Minimum 1 file per cluster
- Every file must appear in exactly one cluster
- id must be lowercase alphanumeric with hyphens only (e.g. "security-auth")
- focus must be 1-2 sentences of specific review instructions for that domain

Changed files:
${fileList}`,
        })

        // Map filenames back to PRFile objects
        const fileMap = new Map(files.map(f => [f.filename, f]))

        return object.clusters.map(cluster => ({
            id: cluster.id,
            label: cluster.label,
            focus: cluster.focus,
            files: cluster.fileNames
                .map(name => fileMap.get(name))
                .filter((f): f is PRFile => f !== undefined),
        })).filter(c => c.files.length > 0)

    } catch {
        // Fallback: single cluster with all files
        return [{
            id: 'general',
            label: 'Code Review',
            focus: 'Review all aspects: correctness, security, performance, and style.',
            files,
        }]
    }
}
```

---

## 6. New File: `packages/ai/src/prompts/worker.prompt.ts`

```typescript
/**
 * Build a system prompt for a worker agent.
 *
 * The worker receives:
 * - Its cluster label and focus instruction from the supervisor
 * - The diff content for only its assigned files (in the user message)
 * - The runLinter tool
 *
 * It outputs a partial ReviewData JSON — same schema as a full review,
 * but scoped to its files only.
 */
export function buildWorkerPrompt(
    clusterLabel: string,
    focus: string,
    codingStandards?: string,
): string {
    const standardsSection = codingStandards
        ? `\nYour team's coding standards — apply these:\n\n${codingStandards}\n`
        : ''

    return `You are a senior software engineer performing a focused code review.
You are reviewing the "${clusterLabel}" portion of a pull request.

YOUR SPECIFIC FOCUS: ${focus}
${standardsSection}
══════════════════════════════════════════════════════════════
WORKFLOW
══════════════════════════════════════════════════════════════
Step 1 — Analyse the diffs provided.
  Write your running analysis IN PLAIN TEXT before the JSON.
  Think through each file: what changed, what might break, what's good.
  Stay focused on your assigned domain — do not comment on unrelated concerns.

Step 2 — Output the JSON review.
  After your analysis, output the structured review object.
  Begin the JSON block with a line containing only {
  End with a line containing only }
  No markdown fences. No trailing prose after the closing }.

══════════════════════════════════════════════════════════════
TOOLS
══════════════════════════════════════════════════════════════
runLinter — Run ESLint on any JavaScript or TypeScript file content.
  Call this for JS/TS files before reasoning about correctness issues.
  Do NOT call for diffs, patch text, or non-JS/TS languages.

══════════════════════════════════════════════════════════════
JSON OUTPUT FORMAT
══════════════════════════════════════════════════════════════
{
  "summary": "1-2 sentence summary scoped to this cluster only",
  "score": <integer 1-10>,
  "issues": [
    {
      "type": "bug | security | performance | style | suggestion",
      "severity": "critical | warning | info",
      "title": "max 10 words",
      "location": "filename line N",
      "description": "why this is a problem",
      "recommendation": "how to fix it"
    }
  ],
  "positives": ["genuine strengths in this cluster's files"]
}

Review rules:
- Only report issues in your assigned files
- Never manufacture issues
- positives must be honest
- If linter returns no issues, do not add style issues unless you genuinely see them`
}
```

---

## 7. New File: `packages/ai/src/prompts/synthesis.prompt.ts`

```typescript
import type { ReviewData } from '@cra/types'

/**
 * Build the user message for the synthesis agent.
 * The system prompt is the existing buildSystemPrompt('PR_STREAM').
 *
 * The synthesis agent receives all partial cluster reviews and:
 * 1. Produces the final unified score
 * 2. Merges and deduplicates issues
 * 3. Identifies cross-cluster issues (e.g. an auth guard trusting a value
 *    that a repository fetches unsafely)
 * 4. Writes a PR-level summary
 */
export function buildSynthesisUserMessage(
    prUrl: string,
    partialReviews: Array<{ clusterId: string; label: string; review: ReviewData }>,
): string {
    const clusterSummaries = partialReviews.map(({ label, review }) => {
        const issueList = review.issues.map(i =>
            `  - [${i.severity}] ${i.title} at ${i.location}`
        ).join('\n') || '  (no issues found)'

        return `### ${label} (score: ${review.score}/10)
Summary: ${review.summary}
Issues:
${issueList}
Positives: ${review.positives.join(', ') || 'none noted'}`
    }).join('\n\n')

    return `Synthesize the following cluster reviews for PR: ${prUrl}

${clusterSummaries}

Instructions:
1. Produce a single unified summary for the entire PR
2. Merge all issues — include all of them, do not drop any
3. Look for cross-cluster issues: patterns that span multiple clusters
   (e.g. auth data flowing unsafely into a DB query)
4. Assign a final score reflecting the PR as a whole
5. Combine all positives
6. Output the JSON review now.`
}
```

---

## 8. Updated `packages/ai/src/index.ts`

Add these exports:

```typescript
export { planClusters } from './clustering'
export type { ClusterPlan } from './clustering'
export { buildWorkerPrompt } from './prompts/worker.prompt'
export { buildSynthesisUserMessage } from './prompts/synthesis.prompt'
```

---

## 9. Core Change: `apps/server/src/review/review.service.ts`

This is the most important file. The change is entirely inside
`streamAnalyzeFromPR`. No other method changes.

### 9.1 New imports to add at the top

```typescript
import {
    buildSystemPrompt,
    ReviewDataSchema,
    createRunLinterTool,
    planClusters,
    buildWorkerPrompt,
    buildSynthesisUserMessage,
} from '@cra/ai'
import type { ReviewData, ClusterPlan } from '@cra/ai'
```

### 9.2 Replace `streamAnalyzeFromPR` entirely

The new implementation has four clearly separated phases. Read the inline
comments carefully — they explain every decision.

```typescript
async streamAnalyzeFromPR(prUrl: string, res: Response): Promise<void> {
    this.githubService.assertValidPRUrl(prUrl)

    const { send, startedAt } = initSse(res)

    try {
        send({ type: 'start' })

        // ── Phase 1: Fetch files and plan clusters in parallel ────────────
        // RAG retrieval and file fetching can run simultaneously.
        const [standards, files] = await Promise.all([
            this.ragService.retrieveForContext('code review standards best practices'),
            this.githubService.fetchPRFiles(prUrl).catch(() => null),
        ])

        // Fallback: if file fetch fails entirely, use old single-agent path
        if (!files || files.length === 0) {
            return this.streamAnalysis(
                `Please review this GitHub pull request: ${prUrl}`,
                standards, prUrl, 'PR', res, { send, startedAt },
            )
        }

        // Use lightweight LLM call to plan clusters intelligently
        // Falls back to single "general" cluster automatically on error
        const clusters = await planClusters(files, this.openai)

        // Tell the UI exactly what clusters exist — it renders panels immediately
        send({
            type: 'cluster_plan',
            clusters: clusters.map(c => ({
                id: c.id,
                label: c.label,
                focus: c.focus,
                fileNames: c.files.map(f => f.filename),
            })),
        })

        // ── Phase 2: Run all worker agents in parallel ────────────────────
        // Promise.allSettled means one failing cluster never blocks the others.
        const workerResults = await Promise.allSettled(
            clusters.map(cluster =>
                this.runWorkerAgent(cluster, standards, send)
            )
        )

        // Collect successful results — failed clusters are noted but not fatal
        const partialReviews = workerResults
            .map((result, i) => ({
                result,
                cluster: clusters[i],
            }))
            .filter(({ result }) => result.status === 'fulfilled')
            .map(({ result, cluster }) => ({
                clusterId: cluster.id,
                label: cluster.label,
                review: (result as PromiseFulfilledResult<ReviewData>).value,
            }))

        if (partialReviews.length === 0) {
            send({ type: 'error', message: 'All cluster agents failed. Please try again.' })
            res.end()
            return
        }

        // ── Phase 3: Synthesis agent ──────────────────────────────────────
        // One final LLM call that sees all partial reviews and produces
        // the unified output — including cross-cluster issue detection.
        const synthesisMessage = buildSynthesisUserMessage(prUrl, partialReviews)
        const synthesisSystem = standards
            ? `${buildSystemPrompt('PR_STREAM')}\n\nYour team's coding standards:\n\n${standards.content}`
            : buildSystemPrompt('PR_STREAM')

        const { text: synthesisText } = await generateText({
            model: this.openai('gpt-4o-mini'),
            system: synthesisSystem,
            messages: [{ role: 'user', content: synthesisMessage }],
            temperature: 0.2,
        })

        const finalReview = this.parseReviewText(synthesisText)
        const merged = { ...finalReview, appliedStandards: standards?.appliedNames }
        const id = await this.saveReview(prUrl, 'PR', merged)

        send({
            type: 'complete',
            review: { ...merged, id },
            durationMs: Date.now() - startedAt,
            stepCount: clusters.length + 1, // workers + synthesis
        })

    } catch (err) {
        const message = err instanceof Error ? err.message : 'PR review failed'
        send({ type: 'error', message })
    } finally {
        res.end()
    }
}
```

### 9.3 New private method: `runWorkerAgent`

Add this private method to `ReviewService`. It runs one cluster's agent,
emits SSE events tagged with the clusterId, and resolves to a partial
`ReviewData`.

```typescript
private async runWorkerAgent(
    cluster: ClusterPlan,
    standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
    send: (event: ReviewStreamEvent) => void,
): Promise<ReviewData> {
    const workerStart = Date.now()

    // Build the diff context for this cluster's files only
    const MAX_PATCH_CHARS = 3_000
    const fileSection = cluster.files.map(f => {
        const patch = f.patch
            ? (f.patch.length > MAX_PATCH_CHARS
                ? f.patch.slice(0, MAX_PATCH_CHARS) + '\n… [diff truncated]'
                : f.patch)
            : `(no diff — ${f.status})`
        return `### ${f.filename}  [+${f.additions} -${f.deletions}  status: ${f.status}]\n${patch}`
    }).join('\n\n')

    const userMessage =
        `Review the following files from the pull request.\n\n` +
        `Your focus: ${cluster.focus}\n\n` +
        fileSection

    const system = buildWorkerPrompt(
        cluster.label,
        cluster.focus,
        standards?.content,
    )

    // Worker tools: only runLinter — diffs are pre-built, no GitHub API calls needed
    const tools = {
        runLinter: createRunLinterTool(({ code, language }) =>
            this.linterService.lint(code, language),
        ),
    }

    const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
    const thinking = new ThinkingStream(
        // Tag every thinking event with this cluster's id
        (event) => send({ ...event, clusterId: cluster.id })
    )

    const { onChunk, onStepFinish } = this.buildStreamCallbacks(
        // Tag all tool events with this cluster's id
        (event) => send({ ...event, clusterId: cluster.id } as ReviewStreamEvent),
        pending,
        thinking,
    )

    const result = streamText({
        model: this.openai('gpt-4o-mini'),
        system,
        messages: [{ role: 'user', content: userMessage }],
        tools,
        temperature: 0.2,
        stopWhen: ({ steps }) => {
            const lastText = steps.at(-1)?.text ?? ''
            try { this.parseReviewText(lastText); return true } catch { /* keep going */ }
            return steps.length >= 5  // worker agents get fewer steps than full reviews
        },
        prepareStep: ({ steps }) => {
            if (steps.length >= 4) return { toolChoice: 'none' as const }
            return {}
        },
        onChunk,
        onStepFinish,
    })

    const [finalText, steps] = await Promise.all([result.text, result.steps])

    const allTexts = [finalText, ...steps.map(s => s.text).reverse()].filter(t => t.trim())
    let review: ReviewData | undefined
    for (const text of allTexts) {
        try { review = this.parseReviewText(text); break } catch { /* try next */ }
    }

    if (!review) {
        throw new Error(`Worker agent for cluster "${cluster.id}" did not return a valid review.`)
    }

    // Signal completion for this cluster
    send({
        type: 'cluster_done',
        clusterId: cluster.id,
        issueCount: review.issues.length,
        durationMs: Date.now() - workerStart,
    })

    return review
}
```

### 9.4 Small fix: `ThinkingStream` constructor

`review.thinking.ts` currently hardcodes `send` as `(event: ReviewStreamEvent) => void`.
The worker agent needs to pass a wrapped sender. Check the constructor signature —
if `send` is a private field typed as the full union, update it to accept a
callback:

```typescript
// In apps/server/src/review/review.thinking.ts
// Change the constructor parameter type from the specific event type
// to a general callback:

constructor(private readonly send: (event: { type: 'thinking'; text: string }) => void) {}
```

This lets worker agents wrap `send` to inject `clusterId` before forwarding.

---

## 10. Frontend Changes

### 10.1 `apps/client/lib/use-review-stream.ts`

Add cluster state to the hook. The key additions are `clusterMap` (one entry
per cluster, tracking its traces and completion status) and handlers for the
two new event types.

```typescript
// ADD these types:

export type ClusterState = {
    id: string
    label: string
    focus: string
    fileNames: string[]
    traceEntries: TraceEntry[]
    taskItems: TaskItem[]
    isDone: boolean
    issueCount?: number
    durationMs?: number
}

// ADD to UseReviewStreamReturn:
clusterMap: Map<string, ClusterState>

// ADD to state:
const [clusterMap, setClusterMap] = useState<Map<string, ClusterState>>(new Map())

// ADD to resetState():
setClusterMap(new Map())

// ADD these cases to the dispatch switch:

case 'cluster_plan':
    setClusterMap(() => {
        const m = new Map<string, ClusterState>()
        for (const c of event.clusters) {
            m.set(c.id, {
                id: c.id,
                label: c.label,
                focus: c.focus,
                fileNames: c.fileNames,
                traceEntries: [],
                taskItems: [],
                isDone: false,
            })
        }
        return m
    })
    break

case 'cluster_done':
    setClusterMap(prev => {
        const next = new Map(prev)
        const existing = next.get(event.clusterId)
        if (existing) {
            next.set(event.clusterId, {
                ...existing,
                isDone: true,
                issueCount: event.issueCount,
                durationMs: event.durationMs,
            })
        }
        return next
    })
    break

// MODIFY the existing 'thinking' case to route by clusterId:

case 'thinking': {
    const seq = ++thinkingSeqRef.current
    const entry: TraceEntry = { kind: 'thinking', id: `thinking-${seq}`, text: event.text }

    if (event.clusterId) {
        // Route to the correct cluster
        setClusterMap(prev => {
            const next = new Map(prev)
            const cluster = next.get(event.clusterId!)
            if (cluster) {
                next.set(event.clusterId!, {
                    ...cluster,
                    traceEntries: [...cluster.traceEntries, entry],
                })
            }
            return next
        })
    } else {
        // Fallback: non-clustered path (code review)
        setTraceEntries(prev => [...prev, entry])
    }
    break
}

// MODIFY 'tool_start' and 'tool_done' similarly — route by clusterId when present
```

### 10.2 `apps/client/components/review/review-progress.tsx`

When `clusterMap` has entries, render a `ClusterPanel` per cluster instead of
(or alongside) the existing single trace panel.

```tsx
// Add this new component to the file:

interface ClusterPanelProps {
    cluster: ClusterState
}

function ClusterPanel({ cluster }: ClusterPanelProps) {
    const [open, setOpen] = useState(true)
    const grouped = useMemo(() => groupEntries(cluster.traceEntries), [cluster.traceEntries])

    return (
        <div className="ml-1 pl-4 border-l border-gray-800">
            <button
                onClick={() => setOpen(p => !p)}
                className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-2"
            >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {cluster.isDone
                    ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                    : <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                }
                <span className="font-medium text-gray-300">{cluster.label}</span>
                {cluster.isDone && cluster.issueCount !== undefined && (
                    <span className="text-gray-600 text-xs">
                        {cluster.issueCount} issue{cluster.issueCount !== 1 ? 's' : ''}
                        {cluster.durationMs != null && ` · ${formatDuration(cluster.durationMs)}`}
                    </span>
                )}
                {!cluster.isDone && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                )}
            </button>

            {open && grouped.length > 0 && (
                <div className="space-y-2 mb-3">
                    {grouped.map(group => {
                        if (group.kind === 'thinking-group')
                            return <ThinkingGroup key={group.id} entries={group.entries} />
                        return <ToolStep key={group.entry.id} entry={group.entry} />
                    })}
                </div>
            )}
        </div>
    )
}

// Modify ReviewProgress to render cluster panels when clusterMap is populated:
// Pass clusterMap as a prop from the parent page and render it like this:

{clusterMap.size > 0 && (
    <div className="space-y-1">
        {[...clusterMap.values()].map(cluster => (
            <ClusterPanel key={cluster.id} cluster={cluster} />
        ))}
    </div>
)}
```

Pass `clusterMap` down from `useReviewStream` through the page component to
`ReviewProgress`. Update the prop type in `ReviewProgress` accordingly.

---

## 11. Edge Cases the Implementation Must Handle

### 11.1 Small PRs (1–3 files)

`planClusters` already returns a single "general" cluster for PRs with ≤ 3
files. The rest of the flow is identical — single worker, no synthesis needed.
The synthesis step should be skipped when there is only one partial review;
just use that review directly as the final output.

Add this check before calling `runSynthesisAgent`:

```typescript
if (partialReviews.length === 1) {
    // No synthesis needed — the single worker's review IS the final review
    const only = partialReviews[0].review
    const merged = { ...only, appliedStandards: standards?.appliedNames }
    const id = await this.saveReview(prUrl, 'PR', merged)
    send({ type: 'complete', review: { ...merged, id }, durationMs: Date.now() - startedAt, stepCount: 1 })
    res.end()
    return
}
```

### 11.2 All workers fail

Already handled: `Promise.allSettled` + the `partialReviews.length === 0`
check sends an error event and closes the connection.

### 11.3 planClusters LLM call fails

Already handled inside `planClusters` — it catches all errors and returns a
single "general" cluster. The rest of the flow proceeds normally.

### 11.4 Binary files and files with no diff

In `runWorkerAgent`, files where `f.patch` is undefined get the string
`(no diff — ${f.status})`. The agent will note them as unchecked rather than
crashing.

### 11.5 Very large PRs (30+ files)

`planClusters` caps at 4 clusters regardless of file count. Large clusters
will have many files each but `MAX_PATCH_CHARS = 3_000` per file keeps the
total context bounded. The per-worker context is at most
`4 clusters × (30/4 files) × 3000 chars ≈ 90K chars` worst case — well within
GPT-4o-mini's 128K token window.

### 11.6 Concurrent SSE writes from parallel workers

Node.js is single-threaded. Multiple `send()` calls from `Promise.allSettled`
workers will be interleaved but never concurrent in the true sense — no
locking needed. The `res.write()` calls will execute in the event loop's
natural order.

---

## 12. Testing the Implementation

### Manual test sequence

1. Start the dev server: `pnpm dev` from repo root
2. Open the web app at `http://localhost:3000`
3. Switch to "GitHub PR" mode
4. Paste a public PR URL with 5+ changed files across multiple directories
5. Verify:
   - `cluster_plan` event renders multiple cluster panels immediately
   - Each panel updates independently with thinking/tool events as workers run
   - Panels show green checkmark + issue count when worker completes
   - Final review appears after all workers finish
   - The review contains issues from all clusters

### Good test PRs (public, varied file types)

- Any PR in `vercel/next.js`, `nestjs/nest`, or `prisma/prisma` that touches
  multiple directories will exercise the clustering logic well.

### Verify parallel execution

Add a `console.log` timestamp at the start of each `runWorkerAgent` call.
All three should log within milliseconds of each other, not sequentially.

---

## 13. What NOT to Change

Be explicit with Cursor / Claude Code:

- Do NOT change `analyzeCode`, `analyzeFromPR`, or `streamAnalyzeCode`
- Do NOT change the `review.sse.ts` SSE infrastructure
- Do NOT change any controller signatures
- Do NOT change `review.formatter.ts`
- Do NOT change how the non-clustered code review path works in the frontend
- Do NOT add new npm packages — everything needed is already installed
  (`ai`, `@ai-sdk/openai`, `zod` are all present in `packages/ai/package.json`)
- Do NOT change the Prisma schema — the `Review` model saves the final merged
  review exactly as before

---

## 14. Summary of the Mental Model

When you are done, a PR review works like this:

```
Developer submits PR URL
    ↓
Supervisor (TypeScript) fetches files + asks LLM to plan clusters (~1 second)
    ↓
UI renders N cluster panels immediately
    ↓
N worker agents run IN PARALLEL
  Each agent:
    - Has a focused system prompt for its domain
    - Runs linter on its files
    - Emits thinking + tool events tagged with its clusterId
    - Returns a partial ReviewData
    - Emits cluster_done
    ↓ (all workers finish — wall time = slowest worker, not sum)
Synthesis agent sees all partial reviews
  - Merges issues, finds cross-cluster patterns, writes final summary
    ↓
complete event → ReviewPanel renders as before
```

The user experience is: multiple panels lighting up and updating
simultaneously, then converging into one final review. The review quality is
higher because each domain got undivided attention. The total time is lower
because workers ran in parallel.