# Remediation Progress Board

Master status for the 80 findings in `AUDIT-REPORT.md`. Update this file at chunk start (→ `in-progress`) and completion (→ `done`, with date + notes). Protocol: `remediation/README.md`.

**Status legend:** `pending` · `in-progress` · `blocked` (say why) · `done`

| Chunk | Status | Findings | Closed | Date | Notes / deviations |
|---|---|---|---|---|---|
| 00 database-deploy-reproducibility | pending | M-1, M-2, M-7, E-3, M-9 (5) | 0/5 | — | Q1 must be answered first |
| 01 server-runtime-bugs | pending | S-1, S-3, S-7, S-8 (4) | 0/4 | — | Ungated — good first code chunk |
| 02 security-cost-posture | pending | C-1, S-4, S-5, M-3, A-31, A-32 (6) | 0/6 | — | Q2, Q3, Q5 gate parts |
| 03 docs-streaming-architecture | pending | A-1…A-10, B-1…B-4, B-6, A-37 (16) | 0/16 | — | Shares README with 06 — run sequentially |
| 04 docs-packages-types-reviewcode | pending | A-11…A-16, A-35, A-36 (8) | 0/8 | — | — |
| 05 docs-datamodel-rag | pending | A-17…A-20 (4) | 0/4 | — | Owns data-model.md exclusively |
| 06 docs-frontend-history-deploy-misc | pending | A-21…A-30, A-33, A-34, A-38, B-5, C-4, C-5, C-6 (17) | 0/17 | — | Shares README with 03 — run sequentially |
| 07 client-reliability-ux | pending | C-2, C-7 (2) | 0/2 | — | Ungated |
| 08 hygiene-deadcode-deps-ci | pending | M-5, M-6, M-8, C-3, S-9, E-1, E-2, E-4…E-8 (12) | 0/12 | — | CI last; Q6 gates E-6 wording |
| 09 deferred-decision-records | pending | S-2, M-4, S-6, S-10, S-11, M-10 (6) | 0/6 | — | ADRs only; Q4, Q7 |
| **Total** | | **80** | **0/80** | | |

## Session log

Append one line per work session: `YYYY-MM-DD · chunk NN · what happened · verification result`

- 2026-08-12 · setup · remediation system created (AGENTS.md, pointers, 10 chunks) · no code changes

## Discovered during remediation

New issues found while executing chunks land here (do NOT fix mid-chunk). Triage into a chunk later.

| # | Found in | Description | Severity suggestion |
|---|---|---|---|
| — | — | — | — |
