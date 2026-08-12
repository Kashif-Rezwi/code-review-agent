# Chunk NN — <slug>

> **Status:** pending · **Findings:** <IDs> (<n>) · **Severity mix:** 🔴x 🟠y 🟡z
> **Depends on:** <chunk IDs or "none"> · **Gated by:** <open questions or "nothing — executable now">
> **Files touched:** <explicit list — check before starting parallel work>

## 1. Goal & why it matters

<2–4 sentences: what this chunk achieves and its engineering/product impact.>

## 2. Context brief (ground truth)

<Distilled, verified facts about the current implementation — enough that the executor
does NOT need to reverse-engineer the subsystem before starting. Include real key names,
signatures, constants, and file:line pointers. State what IS true, not what docs claim.>

## 3. Findings covered

| ID | Sev | Finding (from AUDIT-REPORT.md) |
|---|---|---|
| X-1 | 🟠 | <verbatim or lightly condensed finding row> |

## 4. Read first (sources of truth)

- `<path>` — what to look at
- `AUDIT-REPORT.md` §<n> — the finding rows

## 5. Tasks (in order)

1. [ ] **<Task>** — <concrete instruction>. **Acceptance:** <observable criterion>.

## 6. Verification

```bash
<exact commands, expected outcomes>
```

## 7. Guardrails

- <do-NOT list specific to this chunk>
- Never edit applied Prisma migrations; never commit `.env`; stay in scope.

## 8. Done checklist

- [ ] All tasks complete, all acceptance criteria met
- [ ] Verification green
- [ ] `PROGRESS.md` updated (status, date, findings closed, deviations)
