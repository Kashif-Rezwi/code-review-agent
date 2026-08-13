# 006 — `ReviewService` size is a watch-item, not a refactoring mandate

- **Status:** Accepted (recorded, 2026-08-12)
- **Audit finding:** M-10

## Context

`ReviewService` is a ~940-line orchestrator (session management, CODE and PR
pipelines, worker pool, synthesis, deterministic fallback, error mapping). It
works, is well-commented, and is covered by the behavioral suite. The audit
explicitly noted it as watch-item debt, **not** a refactoring mandate. Related
inconsistency: `RagRepository.insertDocumentWithEmbeddings` lacks the `hasDb`
guard its siblings have (moot since ADR 001 kept the guards as live paths).

## Options

- **(a)** Record as a watch-item; no extraction now.
- **(b)** Extract orchestration helpers (worker pool, synthesis, fallback) into
  collaborators.

## Decision

**(a) watch-item only.** Extraction without a driving feature change risks
behavior regressions in the most critical pipeline for zero user-visible gain.

## Consequences

- No code change.
- Revisit when the file next needs a feature change; extract along the seam
  that change touches.

## Links

- `apps/server/src/review/review.service.ts`
