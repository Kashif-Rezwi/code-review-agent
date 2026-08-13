# Chunk 01 — Server runtime bugs

> **Status:** done (2026-08-12) · **Findings:** S-1, S-3, S-7, S-8 (4) · **Severity mix:** 🟠2 🟡2
> **Depends on:** none · **Gated by:** nothing — executable now (recommended first code chunk)
> **Files touched:** `apps/server/src/review/review.controller.ts`, `apps/server/src/review/dto/` (new `create-session.dto.ts`; delete `create-review.dto.ts`, `create-pr-review.dto.ts`), `apps/server/src/linter/linter.service.ts`, `apps/server/src/ai/ai-runtime.adapter.ts`, `apps/server/src/review/review.formatter.ts`, `apps/server/src/rag/rag.repository.ts`, `apps/server/src/rag/rag.service.ts`, `apps/server/src/main.ts`, + specs

## 1. Goal & why it matters

Fix the four confirmed server runtime bugs. Two are user-facing: an invalid review-session payload returns a misleading 500 ("Database not configured"), and the linter `tool_done` label **always says "clean"** even when ESLint found issues — misinformation in the live stream. The other two are correctness/API-contract bugs (500-instead-of-404, wrong port log). All fixes are small and testable.

## 2. Context brief (ground truth)

- `review.controller.ts:18-23` — `createSession(@Body() dto: { type: 'CODE'|'PR'; input: string })`. The inline type means the global `ValidationPipe` (`main.ts:8`, `whitelist: true`) never validates it. `ReviewRepository.createSession` catches Prisma errors → returns `null` → `ReviewService.createSession` throws `InternalServerErrorException('Database not configured or failed to create session')` — so `{"type":"FOO"}` yields a 500 with a *wrong* message.
- Dead DTOs (zero importers, old `/review/analyze` + `/review/from-pr` API): `dto/create-review.dto.ts` (`{ code: string }`), `dto/create-pr-review.dto.ts` (`{ prUrl: string }`).
- Validated-DTO pattern to copy: `history/dto/chat-message.dto.ts` (`@IsString() @IsNotEmpty() @MaxLength(2000)`).
- `linter.service.ts` — `lint(code, _language): Promise<string>` returns strings (`'No lint issues found.'` / `'ESLint found N issue(s):\n…'` capped at 20 / parse-failure fallback). The string goes to the model via the tool.
- `review.formatter.ts:45-66` — `toolDoneLabel('runLinter', args, result)` reads `result.errors?.length` / `result.warnings?.length` from what is actually a **string** → always 0 → always "`<file>` — clean · N chars".
- `ai-runtime.adapter.ts` — `createLinterRuntimeTool(execute: (input) => Promise<string>)` isolates AI SDK generics; `review.service.ts:910` wires it: `({ code, language }) => this.linterService.lint(code, language)`.
- `rag.repository.ts:95-97` — `deleteDocument` uses `prisma.document.delete({ where: { id, userId } })`; no row → Prisma P2025 → 500. The 404 pattern already exists: `history.repository.deleteReview` uses `deleteMany` + `count > 0`, service throws `NotFoundException`.
- `main.ts:19` — `console.log('Server running on port 4000')` hardcoded; Render sets `PORT=10000`.

## 3. Findings covered

| ID | Sev | Finding |
|---|---|---|
| S-1 | 🟠 | `POST /review/session` body unvalidated → invalid `type` reaches Prisma → misleading 500; ready-made DTOs are dead code |
| S-3 | 🟠 | `toolDoneLabel` reads `result.errors/.warnings` but `LinterService.lint` returns a string → label always renders "clean" |
| S-7 | 🟡 | `main.ts` logs hardcoded port 4000 regardless of `PORT` |
| S-8 | 🟡 | `RagRepository.deleteDocument` throws P2025 → 500 instead of 404 for missing/foreign docs |

## 4. Read first

- `apps/server/src/review/review.controller.ts`, `review.service.ts` (createSession), `review.repository.ts:20-36`
- `apps/server/src/linter/linter.service.ts`, `apps/server/src/review/review.formatter.ts`, `apps/server/src/ai/ai-runtime.adapter.ts`, `packages/ai/src/tools/linter.tool.ts`
- `apps/server/src/rag/rag.repository.ts` + `rag.service.ts` + `rag.controller.ts` (delete path), `history/history.repository.ts:72-75` (the 404 pattern)
- Existing specs: `review.service.spec.ts`, `review.processor.spec.ts` (follow their mocking style)

## 5. Tasks

1. [x] **S-1 — real DTO.** Create `dto/create-session.dto.ts`: `type` with `@IsIn(['CODE','PR'])`; `input` with `@IsString() @IsNotEmpty() @MaxLength(100_000)` (aligned with Express's default body limit; PR URLs and pastes both fit). Use it in `createSession`. Delete the two dead DTO files. **Acceptance:** `POST /review/session {"type":"FOO","input":"x"}` → **400** with a clear message; missing `input` → 400; valid payload still creates a session.
2. [x] **S-1 test.** Add a spec asserting invalid `type` is rejected before the repository is called (mock repo). **Acceptance:** suite stays green with the new spec.
3. [x] **S-3 — structured linter result.** Change `LinterService.lint` to return `{ output: string; errors: number; warnings: number; parseError: boolean }` (`output` = the current strings, **wording unchanged** — the model surface stays identical; parse-failure fallback sets `parseError: true`, counts 0). Update the `ai-runtime.adapter.ts` execute type; in `review.service.ts` pass `result.output` onward as the tool result so the model still receives plain text. Update `toolDoneLabel` to use the real counts: "`N issues`" when `errors+warnings > 0`; "clean" only when 0 and not `parseError`; "could not parse" when `parseError`. **Acceptance:** code with violations renders "`<file>` — N issues · M chars"; clean code renders "clean".
4. [x] **S-3 tests.** Specs for `LinterService` counts (clean / violations / unparsable input) and `toolDoneLabel` outcomes.
5. [x] **S-8 — 404 semantics.** `deleteDocument` → `deleteMany({ where: { id, userId } })`; `RagService` throws `NotFoundException` when `count === 0`. **Acceptance:** deleting a missing/foreign document → 404, not 500; happy path unchanged.
6. [x] **S-7 — honest port log.** `const port = process.env.PORT ?? 4000; await app.listen(port); console.log(\`Server running on port ${port}\`)`.

## 6. Verification

```bash
pnpm build:packages && pnpm type-check
pnpm --filter server test                                   # all green incl. new specs
cd apps/server && npx eslint "{src,apps,libs,test}/**/*.ts" # exit 0
# Optional live check (needs apps/server/.env + auth token):
#   curl -X POST localhost:4000/review/session -H 'Authorization: Bearer <token>' \
#     -H 'Content-Type: application/json' -d '{"type":"FOO","input":"x"}'   → 400
```

## 7. Guardrails

- Do not change the linter rule set, the 20-message cap, or the string **wording** the model sees.
- Do not wire up `@typescript-eslint/parser` — that is S-6, a chunk-09 decision.
- Do not touch streaming/cancellation/dispatcher code.
- Keep the graceful parse-failure fallback — the agent loop must never crash on unparsable code.

## 8. Done checklist

- [x] 400 (not 500) on invalid session payload; dead DTOs deleted
- [x] Linter label reflects the real ESLint outcome
- [x] Delete-missing-document → 404
- [x] Port log uses actual `PORT`
- [x] Tests + type-check + lint green; `PROGRESS.md` updated (4 findings)

## Outcome notes (2026-08-12)

- **Discovery folded into S-3:** the linter was *fully* dead — `linter.verify()` was passed an eslintrc-style config (`parserOptions` top-level), which ESLint 9's flat-config `Linter` rejects on every call, so the catch fallback (`Linter could not parse…`) was the only output ever produced. The minimal config-shape fix (`languageOptions.{ecmaVersion, sourceType, parserOptions.ecmaFeatures}`) was required for S-3's acceptance ("violations render N issues"). Rule set, 20-message cap, and model-facing wording unchanged. Recorded in PROGRESS.md "Discovered during remediation".
- **S-3 contract (as anticipated by chunk 04):** `LinterService.lint` returns `LintResult { output, errors, warnings, parseError }`; `createLinterRuntimeTool(execute, outcomes?)` unwraps `output` for the model and stashes the structured outcome keyed by the exact code string; `toolDoneLabel` reads real counts from that map. Fatal parser messages (e.g. TS-only syntax) count as `parseError`, never as violations.
- New specs: `linter.service.spec.ts`, `review.formatter.spec.ts`, `review.controller.spec.ts` (supertest through the real ValidationPipe), `rag.service.spec.ts`, `rag.repository.spec.ts` — 17 suites / 65 tests total.
