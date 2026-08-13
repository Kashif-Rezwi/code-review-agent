# Remediation — Execution Protocol

This directory operationalizes [`AUDIT-REPORT.md`](../AUDIT-REPORT.md) (80 findings: A/S/C/E/M series). Work is split into **10 self-contained chunks** in `chunks/`. Each chunk groups only related topics and embeds everything needed to execute it: findings with evidence, a ground-truth context brief, ordered tasks, verification commands, and guardrails.

**Designed for cold starts:** any AI provider, in a brand-new chat, can execute any chunk without prior conversation history.

## The loop

```
1. SYNC      Read AGENTS.md (repo rules) → this file → remediation/PROGRESS.md
2. PICK      Choose the next pending chunk in the execution order below
             (or the one assigned to you). Check its "Dependencies" section first.
3. LOAD      Read the chunk file fully, then every file in its "Read first" list.
4. DECIDE    If the chunk lists blocking open questions, get answers from the
             human before writing code. Decision-gated tasks say so explicitly.
5. IMPLEMENT Work through the chunk's tasks in order. Stay in scope.
6. VERIFY    Run the chunk's "Verification" commands; all must pass.
             Baseline today is green — do not merge anything that breaks it.
7. RECORD    Check off the chunk's Done list; update PROGRESS.md
             (status, date, findings closed, notes/deviations).
8. COMMIT    One commit per chunk: `fix(audit): chunk NN — <slug>`
             (docs chunks: `docs(audit): chunk NN — <slug>`).
```

## Execution order

| Order | Chunk | Focus | Findings | Gated by |
|---|---|---|---|---|
| 1 | `00-database-deploy-reproducibility` | Prisma baseline migration, indexes, render.yaml | 5 | Q1 |
| 2 | `01-server-runtime-bugs` | DTO validation, linter label, 404, port log | 4 | — |
| 3 | `02-security-cost-posture` | OAuth scope, `?token=`, rate limiting, CORS, auth docs | 6 | Q2, Q3, Q5 |
| 4 | `07-client-reliability-ux` | API-URL build guard, chat error surfacing | 2 | — |
| 5 | `08-hygiene-deadcode-deps-ci` | Dead deps/code, e2e landmine, shutdown hooks, CI last | 12 | Q6 |
| 6 | `03-docs-streaming-architecture` | queue-streaming.md rewrite, architecture.md, README | 16 | — |
| 7 | `04-docs-packages-types-reviewcode` | packages.md, tools list, parser/linter docs | 9 | — |
| 8 | `05-docs-datamodel-rag` | data-model.md, rag.md | 4 | — |
| 9 | `06-docs-frontend-history-deploy-misc` | frontend/deployment/history docs, spec banner, copy | 16 | — |
| 10 | `09-deferred-decision-records` | ADRs for deferred items | 6 | Q4, Q7 |

Rationale: code before docs (docs must describe the fixed reality, not an intermediate state); CI lands inside chunk 08 *after* the e2e landmine (M-6) is removed and includes a `migrate deploy` smoke step that permanently locks in chunk 00's fix.

**Open questions** (full text in `AUDIT-REPORT.md` §11): Q1 baseline-reconciliation strategy · Q2 user-token private-PR roadmap · Q3 deployment exposure · Q4 BullMQ concurrency intent · Q5 `?token=` consumers · Q6 Stripe/Groq/Helicone label-vs-drop · Q7 S-2 direction.

## Rules for every chunk

1. **One chunk at a time.** Do not start a new chunk while another is `in-progress` (chunks may share files — see each chunk's "Files touched" section).
2. **Stay in scope.** Fix only the findings assigned to your chunk. Found something new? Add it to `PROGRESS.md` under "Discovered during remediation" — don't fix it mid-chunk.
3. **No behavior changes beyond the finding.** Preserve working behavior unless the finding demands the change.
4. **Never edit applied Prisma migrations.** New migration files only.
5. **Update docs when you change behavior.** If your chunk changes something a doc describes, fix the doc line in the same chunk (even if another chunk owns that doc's bigger rewrite — note it in PROGRESS.md).
6. Chunks 03–06 are documentation-only: no code edits except where a task explicitly says so (e.g., copy fixes in 06).
