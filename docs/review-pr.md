# PR Review Pipeline (Coverage-Safe Multi-Agent)

## Overview

Every pull request now enters one acquisition-independent pipeline:

```text
GitHub files API ─┐
                  ├─ PRSnapshot → exact-once plan → workers → synthesis → persisted review
Public .diff ─────┘
```

The public diff is an acquisition fallback, not a review fallback. A GitHub API failure can no longer send a bare URL or one large text prefix to a generic agent. Both acquisition sources produce normalized per-file records before worker count is selected.

## 1. Acquisition

`GithubService.fetchPRSnapshot()` returns:

```ts
interface PRSnapshot {
  files: NormalizedPRFile[]
  source: 'github_files_api' | 'public_diff'
  complete: boolean
  warnings: string[]
}
```

The files API is primary and paginated. Each file is tagged as `full`, `truncated`, `metadata_only`, or `binary`; renames retain `previousFilename`. Missing API patches are filled from a parsed unified diff when possible.

If authenticated and anonymous file-list attempts fail, the server reads the raw public `.diff` and parses it with the application adapter in `github/unified-diff.parser.ts`. The adapter handles modified, added, deleted, renamed, binary, multi-hunk, no-newline, and space-containing paths.

Safety policy:

- GitHub request timeout: 10 seconds.
- Network failures, `5xx`, `429`, and rate-limit responses: one retry with capped jitter.
- `401` and `404`: no same-request retry; move to the appropriate fallback.
- Raw diff: streamed with a 2 MiB byte limit. If there is no structured file list and the limit is exceeded, the review fails explicitly.
- Token validation: a status-only request runs at startup. `/health` reports `valid`, `invalid`, `missing`, or `unchecked`, never the token.

## 2. Planning and Exact Coverage

Small PRs of up to three files use one worker. Larger PRs request 2–4 relevance-based clusters from the centrally configured AI model.

Planner output is untrusted and reconciled server-side:

- unknown names are discarded;
- the first duplicate assignment wins;
- invalid or duplicate IDs are repaired;
- empty clusters are removed;
- omitted files go to the cluster with the longest shared directory prefix, with lowest context weight as the tie-breaker;
- every original filename must occur exactly once before `cluster_plan` is emitted.

An invalid plan or an invalid single cluster for a larger PR uses a deterministic fallback:

```text
cluster count = min(4, max(2, ceil(fileCount / 6)))
```

The fallback seeds every cluster, groups matching source/test files, uses path affinity, and balances patch size plus changed-line weight.

## 3. Workers and Context

Workers run through a promise pool capped at three concurrent agents. Each cluster receives at most 40,000 patch characters, with an 8,000-character per-file cap. Context selection keeps complete hunks where possible and appends an explicit omission marker; it never silently cuts a diff line.

A worker that throws or returns invalid structured output is retried once at temperature zero with a reinforced JSON-only instruction. Success emits `cluster_done` with the attempt count. A second failure emits `cluster_failed` and remains part of the coverage manifest.

## 4. Synthesis and Outcomes

- Original one-cluster plan + success: return that worker review directly.
- Original multi-cluster plan + one or more successes: always run synthesis, even if only one worker survived.
- Some failed clusters: synthesize successful reviews and save `PARTIAL` with exact unreviewed files.
- All workers failed or no usable files: save `FAILED` and emit one terminal error.

Synthesis keeps two model attempts plus the deterministic merge fallback. Coverage is injected after synthesis by the server, so model output cannot overstate which files were reviewed.

`ReviewData.coverage` records numeric total/assigned/reviewed file counts, truncated and metadata-only files, unreviewed files, failed cluster IDs, and the acquisition source. Truncation is disclosed but remains `COMPLETE` when every cluster succeeds.

## 5. SSE and UI

PR traces can include:

| Event | Meaning |
|---|---|
| `acquisition` | File count, acquisition source, completeness and sanitized warnings |
| `task_plan` / `task_update` | Full-path data collection progress |
| `cluster_plan` | Exact-once worker assignments |
| `cluster_done` | Successful worker, duration and attempt count |
| `cluster_failed` | Failed worker after retry |
| `synthesis_start` | Synthesis began with the successful result count |
| `complete` | Review plus `outcome: complete | partial` |

The client buffers cluster-scoped events received before `cluster_plan` and replays them once the cluster exists. Planner and worker cards render as soon as `clusterMap` exists. Premature SSE closure is surfaced as an error.

PARTIAL reviews are amber, list unreviewed files, remain visible in history and issue statistics, and have a separate aggregate count. Replay mode comes from the persisted review type, so old traces remain valid.

## Persistence and Deployment

The only legal session transitions are:

```text
PENDING → COMPLETE | PARTIAL | FAILED | CANCELLED
```

Updates include `status: PENDING` in the write condition so competing cancellation/completion attempts cannot overwrite a terminal row. Migration `20260718090000_add_partial_review_coverage` adds the enum value and nullable JSONB column.

Deploy in this order:

1. Test the migration on a Neon branch.
2. Run `pnpm --filter server exec prisma migrate deploy` against production.
3. Deploy the server.
4. Deploy the client.
5. Verify `/health`, files-API acquisition, public-diff acquisition, PARTIAL display, and a 20-file PR.

## Main Files

| File | Responsibility |
|---|---|
| `apps/server/src/github/github.service.ts` | Acquisition policy, diagnostics, retries, limits, token health |
| `apps/server/src/github/unified-diff.parser.ts` | Unified-diff normalization adapter |
| `packages/ai/src/clustering.ts` | Planner reconciliation and deterministic fallback |
| `apps/server/src/review/review.service.ts` | Worker pool, retry, synthesis, coverage and terminal outcomes |
| `apps/server/src/review/review.repository.ts` | Atomic persistence |
| `packages/types/src/index.ts` | Review, coverage and SSE contracts |
| `apps/client/lib/review-stream.reducer.ts` | Live/replayed event state and out-of-order buffering |
| `apps/client/components/review/review-progress.tsx` | Acquisition/planner/worker/synthesis trace UI |
