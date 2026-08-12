# Chunk 04 — Docs: packages, types & review-code

> **Status:** pending · **Findings:** A-11, A-12, A-13, A-14, A-15, A-16, A-35, A-36 (8) · **Severity mix:** 🔴3 🟡5
> **Depends on:** chunk 01 (S-3 changes `LinterService`'s return type — document the NEW contract) · **Gated by:** nothing
> **Files touched:** `docs/packages.md`, `docs/architecture.md` (tools list only — coordinate if chunk 03 is in flight), `docs/review-code.md`, `docs/github-integration.md` (one pointer), `remediation/PROGRESS.md`

## 1. Goal & why it matters

`docs/packages.md` documents three GitHub tool factories and a file (`github.tool.ts`) that **do not exist** — an agent following it will import phantom modules. `docs/architecture.md` lists four model-facing tools when only one exists. `docs/review-code.md` misdescribes the review-text parser and implies TypeScript linting works. These are the docs an agent reads first when extending the AI layer.

## 2. Context brief (ground truth)

- `packages/ai/src/tools/` contains **only** `linter.tool.ts` (+`index.ts`). `createFetchGithubPRTool` / `createListPRFilesTool` / `createFetchFileContentTool` were removed when PR acquisition moved server-side to `GithubService.fetchPRSnapshot`. GitHub acquisition is orchestrated **before** any model call — workers run with `tools: {}`.
- `linter.tool.ts`: `createRunLinterTool(execute)` — input schema `linterToolSchema` = `{ code: string, language: 'javascript'|'typescript', filename?: string }` (A-15: the optional `filename` is undocumented). Tool description tells the model to call it only for pasted source, never on diffs. **Note:** after chunk 01 lands, `execute` returns `{ output, errors, warnings, parseError }` and the model receives `output` — document that contract.
- `PRFileSchema` / `PRFile` live in `packages/ai/src/schemas/pr-file.schema.ts` (not `tools/github.tool.ts`); `github-integration.md` mis-points this too (A-13).
- `packages/types/src/index.ts`: `ReviewStreamEvent` union has **14** members: `start`, `heartbeat` (:52), `acquisition`, `thinking`, `task_plan`, `task_update`, `tool_start`, `tool_done`, `complete`, `error`, `cluster_plan`, `cluster_done`, `cluster_failed`, `synthesis_start`. The packages.md table lists 13 and omits `heartbeat` (A-14). Note: the file's stale doc comment (:43-44, removed endpoints) is fixed in chunk 08 (S-9), not here.
- `build:packages` is baked into root `dev`/`build` scripts, but **no CI exists** (`.github/` absent until chunk 08) and the server's own `build` (`prisma generate && nest build`) does not build packages (A-16).
- Parser (`apps/server/src/review/review-parser.util.ts`): multi-candidate extraction — markdown-fence stripping, then balanced-brace extraction from every line-boundary `{` (last to first), then first `{`→balanced `}` as final net; each candidate validated against `ReviewDataSchema`. NOT the "bare `{` on its own line" description in `docs/review-code.md` (A-35).
- TS linting (A-36): `LinterService` uses ESLint's default parser (espree) with `ecmaVersion: 2022, sourceType: 'module', jsx: true` and **ignores** the `language` arg (`void _language`). TypeScript input fails to parse → graceful fallback string. Wiring `@typescript-eslint/parser` is S-6 — a chunk-09 decision; document the limitation (or the new behavior if S-6 already landed — check PROGRESS.md).

## 3. Findings covered

| ID | Sev | Finding |
|---|---|---|
| A-12 | 🔴 | packages.md documents `createFetchGithubPRTool`/`createListPRFilesTool`/`createFetchFileContentTool` — none exist |
| A-13 | 🔴 | packages.md + github-integration.md point at nonexistent `packages/ai/src/tools/github.tool.ts` |
| A-11 | 🔴 | architecture.md tools list: `fetchGithubPR`, `listPRFiles`, `fetchFileContent`, `runLinter` — only `runLinter` exists |
| A-14 | 🟡 | packages.md `ReviewStreamEvent` table (13 events) omits `heartbeat` |
| A-15 | 🟡 | `createRunLinterTool` input also has optional `filename` |
| A-16 | 🟡 | "build:packages baked into CI scripts" — no CI exists; server `build` doesn't build packages |
| A-35 | 🟡 | review-code.md parser description wrong (balanced-brace multi-candidate + fence stripping) |
| A-36 | 🟡 | docs imply TS linting works — espree-only, `language` ignored |

## 4. Read first

- `packages/ai/src/tools/linter.tool.ts`, `packages/ai/src/tools/index.ts`, `packages/ai/src/index.ts` (public exports), `packages/ai/src/schemas/pr-file.schema.ts`
- `packages/types/src/index.ts`
- `apps/server/src/review/review-parser.util.ts`, `apps/server/src/linter/linter.service.ts` (post-chunk-01 version)
- Current `docs/packages.md`, `docs/architecture.md`, `docs/review-code.md`, `docs/github-integration.md`

## 5. Tasks

1. [ ] **Rewrite the tools section of `docs/packages.md`**: only `createRunLinterTool` exists; document its real input schema (incl. `filename`), its post-chunk-01 return contract, and a short note that GitHub acquisition moved server-side (`GithubService.fetchPRSnapshot`) — no model-facing GitHub tools remain. Remove the three phantom factories and the `github.tool.ts` file row; point `PRFileSchema` at `schemas/pr-file.schema.ts`. **Acceptance:** every symbol named in packages.md resolves via grep in `packages/`.
2. [ ] **A-14:** add `heartbeat` to the `ReviewStreamEvent` table (14 members; note it is not persisted in the stream — cross-link the queue-streaming.md section from chunk 03).
3. [ ] **A-16:** correct the build/CI claims (no CI until chunk 08; only root scripts build packages).
4. [ ] **A-11:** fix `docs/architecture.md` tools list to `runLinter` only + the server-side acquisition note. (architecture.md is shared with chunk 03 — touch only the tools list; if 03 is `in-progress`, defer this one edit and note it in PROGRESS.md.)
5. [ ] **A-13 (pointer):** fix the `PRFileSchema` reference in `docs/github-integration.md`.
6. [ ] **A-35 + A-36:** rewrite the parser paragraph in `docs/review-code.md` (multi-candidate balanced-brace + fence stripping + zod validation); state plainly that linting is JS-only today (TS input falls back gracefully) — unless S-6 already landed via chunk 09, in which case document the new behavior.

## 6. Verification

```bash
grep -n 'createFetchGithubPRTool\|createListPRFilesTool\|createFetchFileContentTool\|github.tool.ts' docs/   # expect: no matches
grep -n 'heartbeat' docs/packages.md                                                                       # expect: match
grep -n 'pr-file.schema' docs/packages.md docs/github-integration.md                                       # expect: matches
```

## 7. Guardrails

- Documentation only (no code edits).
- Do not invent exports: every symbol you name must exist under `packages/`.
- Describe the post-chunk-01 linter behavior; check `PROGRESS.md` for 01's status first.

## 8. Done checklist

- [ ] Phantom factories + phantom file removed from docs; symbols grep-clean
- [ ] Event table complete (14); linter input/output contracts documented
- [ ] architecture.md tools list + review-code.md parser/linter sections corrected
- [ ] `PROGRESS.md` updated (8 findings)
