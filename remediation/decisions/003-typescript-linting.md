# 003 — TypeScript-aware linting via `@typescript-eslint/parser`

- **Status:** Accepted & implemented (2026-08-12)
- **Audit finding:** S-6

## Context

`LinterService` used ESLint's default parser (espree) and ignored the
`language` argument, so TypeScript pastes could never be linted — they hit a
fatal parse error and gracefully degraded. Pasted-code review is a core flow
and TS pastes are the common case. (While wiring this we also found that the
flat-config `languageOptions` carried no ambient globals, so `no-undef`
false-flagged `console`/`process`/`window` on realistic pastes — the linter's
config had never actually run before the chunk-01 flat-config fix.)

## Options

- **(a)** Wire `@typescript-eslint/parser` selected by the `language` arg.
- **(b)** Keep documenting the JS-only limitation.

## Decision

**(a)** — with the **same rule set** for both languages. The TS path swaps only
the parser; `jsx: true` stays on so TSX pastes parse. Ambient globals
(`es2022` + `browser` + `node` from the `globals` package) are now provided for
both languages so `no-undef` reports only genuinely undefined identifiers.

## Consequences

- TS/TSX pastes get real lint counts in the stream label and model context.
- Known residual: statement-initial generic arrow functions (`const f = <T>(v: T) => v`)
  are ambiguous in TSX mode — they fall back to the graceful `parseError` path
  (models/users can use `<T,>`). Documented in `docs/review-code.md`.
- `@typescript-eslint/parser` added as a devDependency, mirroring `eslint`'s
  placement (both are dynamically imported by the linter at runtime).

## Links

- `apps/server/src/linter/linter.service.ts`, `apps/server/src/linter/linter.service.spec.ts`
- Chunk 01 outcome notes (D-1 — the flat-config repair that made the linter run at all)
