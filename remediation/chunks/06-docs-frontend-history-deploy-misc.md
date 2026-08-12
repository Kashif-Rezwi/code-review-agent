# Chunk 06 — Docs: frontend, history, deployment & misc

> **Status:** done (2026-08-12) · **Findings:** A-21…A-30, A-33, A-34, A-38, B-5, C-4, C-5, C-6 (17) · **Severity mix:** 🟠9 🟡8
> **Depends on:** chunks 01, 02, 07 (document fixed behavior) · **Gated by:** nothing
> **Files touched:** `docs/frontend.md`, `docs/deployment.md`, `docs/history-chat.md`, `docs/github-integration.md`, `README.md` (env table only — **shared with chunk 03; never run concurrently**), `Clustered-PR-Review-Spec.md` (banner), `apps/client/.env`, `apps/client/.env.example`, `apps/client/lib/use-standards-documents.ts`, `apps/server/src/rag/rag.controller.ts` (error copy), `apps/client/types/review.types.ts` (comment), `remediation/PROGRESS.md`

## 1. Goal & why it matters

A broad but shallow sweep: bring the remaining 🟠/🟡 docs to code-truth (frontend, deployment, history), retire the "single source of truth" claim of a superseded spec, and fix three copy/comment mismatches that actively mislead users (upload file types) and developers (env files, stale component name).

## 2. Context brief (ground truth)

**Frontend (`apps/client`):** `app/page.tsx` → `redirect('/review')` (not `/review/paste_code`); `app/review/page.tsx` renders the review client directly. `proxy.ts` is the Next 16 auth gate (matcher: `/review/:path*`, `/history/:path*`, `/standards/:path*` → `/login` when no NextAuth JWT). Server-wakeup UX exists: `lib/server-wakeup-context.tsx` + `lib/use-server-wakeup.ts` + `components/ui/server-wakeup-banner.tsx` (Render cold-start banner → recovery toast), wired in `app/layout.tsx` (B-5). API client (`lib/api.ts`): `historyService` (getReviews/getStats/getReview/deleteReview), `reviewService` (createSession/getSession/cancelSession), `ragService`; `uploadDocument` takes `FormData` (A-28). `lib/sse.ts` = full SSE frame parser (multiline `data:`, `id:` capture, CRLF, comments) (A-29). `useReviewStream` reconnects with `Last-Event-ID` + backoff `[500,1000,2000]` + event-id dedupe + heartbeat skipping (A-30).

**Deployment:** client Dockerfile uses `output: 'standalone'` — copies `.next/standalone` + `.next/static`, runs `node apps/client/server.js` (not `next start`) (A-21). `apps/client/vercel.json` uses `cd ../..` install/build commands ⇒ Vercel project Root Directory is `apps/client`; it has a custom `ignoreCommand` (builds only on `main` when client/packages/root files changed) (A-22). Server never reads `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` — those are client-only (A-23; fix README + deployment.md env tables). `GROQ_API_KEY`/`HELICONE_API_KEY`/`STRIPE_*` have zero code support (A-24 — labeling happens in chunk 08/E-6; here fix the *docs* to say "not implemented").

**History API:** `DELETE /history/:id` exists (controller + `historyService.deleteReview`); `listReviews` returns only `COMPLETE`/`PARTIAL` reviews (`history.repository.ts:18`) (A-33). `/health` returns `{ status, database, databaseSchema, redis, redisStreams, githubToken }` (A-34; the mechanism doc lands in chunk 03 — here just fix the endpoint response table in github-integration.md).

**Spec banner (A-38):** `Clustered-PR-Review-Spec.md` declares itself "the single source of truth" but is superseded — contradictions table in `AUDIT-REPORT.md` §6.

**Copy/comment fixes:**
- C-4: `apps/client/.env` defines `NEXT_PUBLIC_API_URL` twice (drop the first, stray block); `.env.example` says "change to **Railway** URL in production" → Render.
- C-5: upload error copy says ".txt and .pdf" but `.md` (`text/markdown`) is accepted on both sides (`use-standards-documents.ts:31,58`; `rag.controller.ts:20,42-44`) — update both messages to mention `.md`.
- C-6: `apps/client/types/review.types.ts:7` comment references `ChatPanel` — the component is `ChatThread`.

## 3. Findings covered

| IDs | What to fix |
|---|---|
| A-25, A-26, A-27 🟠 | frontend.md: `/review` redirect + no-redirect review page; add `proxy.ts`; add server-wakeup (B-5) |
| A-28, A-29, A-30 🟡 | frontend.md: full API client surface; real SSE parser; reconnection behavior |
| A-21, A-22 🟠 | deployment.md: standalone Dockerfile flow; Vercel root dir + `ignoreCommand` |
| A-23, A-24 🟠 | env tables in deployment.md + README: client-only OAuth vars; mark Groq/Helicone/Stripe "not implemented" |
| A-33 🟠 | history-chat.md: add `DELETE /history/:id` + the COMPLETE/PARTIAL list filter |
| A-34 🟡 | github-integration.md: full `/health` response fields |
| A-38 🟠 | spec banner → historical, point to `docs/review-pr.md` |
| C-4, C-5, C-6 🟡 | env-file fixes; `.md` in upload copy (client + server); `ChatPanel`→`ChatThread` comment |

## 4. Read first

- `apps/client/app/page.tsx`, `app/review/page.tsx`, `proxy.ts`, `app/layout.tsx`, `lib/api.ts`, `lib/sse.ts`, `lib/use-review-stream.ts`, `lib/server-wakeup-context.tsx`, `lib/use-server-wakeup.ts`
- `apps/client/Dockerfile`, `apps/client/vercel.json`, `render.yaml`
- `apps/server/src/history/history.controller.ts`, `history.repository.ts:16-41`, `health.controller.ts`
- Current `docs/frontend.md`, `docs/deployment.md`, `docs/history-chat.md`, `docs/github-integration.md`, `README.md`, `Clustered-PR-Review-Spec.md`; `AUDIT-REPORT.md` §2.6-2.9, §6

## 5. Tasks

1. [x] **frontend.md (A-25…A-30, B-5):** fix the route structure (`/` → `/review`; review page renders directly); add `proxy.ts` + its matcher; add the server-wakeup subsystem; expand the API-client section (`historyService` incl. `deleteReview`, `reviewService.cancelSession`, `uploadDocument(FormData)`); rewrite the `sse.ts` description (frame parser) and the `useReviewStream` section (reconnect/resume/dedupe/heartbeat skipping). **Acceptance:** every file named in §2's frontend paragraph is represented accurately.
2. [x] **deployment.md (A-21, A-22):** correct the client Dockerfile walkthrough (standalone output, `node apps/client/server.js`); state the Vercel Root Directory is `apps/client` and document the `ignoreCommand` gating (main-branch + path diff).
3. [x] **env tables (A-23, A-24):** in `deployment.md` and `README.md` — move `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` out of the server's required list (client-only, NextAuth); mark `GROQ_API_KEY`, `HELICONE_API_KEY`, `STRIPE_*` as "not implemented — reserved". **Acceptance:** no server env table lists client-only or inert vars as usable/required.
4. [x] **history-chat.md (A-33):** add `DELETE /history/:id` (204; ownership-checked) and note the list endpoint returns only `COMPLETE`/`PARTIAL` reviews.
5. [x] **github-integration.md (A-34):** full `/health` response shape + degraded rule.
6. [x] **A-38 — spec banner:** prepend to `Clustered-PR-Review-Spec.md`: `> ⚠️ HISTORICAL — superseded by docs/review-pr.md and the implementation. Kept for design history; do not implement against this file.` (Adjust the "single source of truth" line accordingly.)
7. [x] **C-4/C-5/C-6:** dedupe `NEXT_PUBLIC_API_URL` in `apps/client/.env`; Railway→Render in `.env.example`; add `.md` to both upload error messages; `ChatPanel`→`ChatThread` in `types/review.types.ts:7`.

## 6. Verification

```bash
grep -n 'Railway\|next start\|paste_code' docs/ README.md apps/client/.env.example            # expect: no stale matches
grep -n 'DELETE /history' docs/history-chat.md && grep -n 'standalone' docs/deployment.md      # expect: matches
grep -n 'single source of truth' Clustered-PR-Review-Spec.md                                    # expect: banner-qualified
pnpm --filter server test && pnpm --filter client test                                        # copy edits touched code
```

## 7. Guardrails

- Docs-only except the three explicitly listed copy/comment edits (C-4, C-5, C-6).
- `README.md` is shared with chunk 03 — this chunk edits **only** its env table; if 03 is in flight, defer and note it.
- `.env` is gitignored — editing it is local-only; also fix `.env.example` so future copies are right.

## 8. Done checklist

- [x] frontend.md / deployment.md / history-chat.md / github-integration.md match code
- [x] Env tables corrected (both files); spec banner added
- [x] C-4/C-5/C-6 applied
- [x] Tests green; `PROGRESS.md` updated (17 findings)
