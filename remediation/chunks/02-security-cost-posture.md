# Chunk 02 — Security & cost posture

> **Status:** done (2026-08-12) · **Findings:** C-1, S-4, S-5, M-3, A-31, A-32 (6) · **Severity mix:** 🟠4 🟡2
>
> **DECISIONS (2026-08-12, repo owner):** **Q2 = no** user-token private-PR plans → drop `repo` scope. **Q3 = public deployment** → implement throttling; final values: **10 sessions/hour** on `POST /review/session`, **60 chat messages/hour** on `POST /history/:id/chat`, per authenticated `userId` (IP fallback), in-memory storage (single-instance note in PROGRESS). **Q5 = no** known `?token=` consumers → deprecation warn-log + docs this chunk; removal later if logs stay clean.
> **Depends on:** none · **Gated by:** **Q2** (user-token private-PR roadmap → C-1), **Q3** (deployment exposure → M-3 scope), **Q5** (any `?token=` consumers → S-4 removal timing). Documentation tasks (A-31/A-32) are ungated.
> **Files touched:** `apps/client/lib/auth.ts`, `apps/server/src/auth/auth.guard.ts`, `apps/server/src/auth/token-cache.service.ts`, `apps/server/src/main.ts`, `apps/server/src/app.module.ts` (+ possibly a throttler module), `apps/server/package.json` (maybe `@nestjs/throttler`), `docs/authentication.md`, `remediation/PROGRESS.md`

## 1. Goal & why it matters

Close the confirmed security/cost gaps: the app requests GitHub's `repo` scope (full private-repo access) it never uses; live user tokens are accepted in URLs (`?token=`), which leak into logs/history; the token cache's "bound" is unenforced; CORS always trusts `localhost:3000` even in prod; and there is **no rate limiting on endpoints that spend OpenAI money**. Individually moderate — together they are the app's whole abuse surface.

## 2. Context brief (ground truth)

- `apps/client/lib/auth.ts:14` — NextAuth GitHub provider scope: `'read:user user:email repo'`. The server uses the user token **only** for `GET /user` identity validation (`github.service.ts fetchUserProfile`); PR fetching uses the server's own `GITHUB_TOKEN` (`github.service.ts:31`) or anonymous access. The `repo` scope is never exercised. Login page copy (`app/login/page.tsx:143-145`) already tells users only `read:user` is required.
- `auth.guard.ts:29-36` — token from `Authorization: Bearer`, else **`?token=` query param**. The client streams via header-capable `fetch` (`use-review-stream.ts`), so no first-party consumer needs the query fallback.
- `token-cache.service.ts:39-49` — at `cache.size >= 500` only **expired** entries are evicted; if all entries are live the Map grows unbounded. TTL default 300 000 ms (`GITHUB_TOKEN_CACHE_TTL_MS`).
- `main.ts:13-16` — CORS origin is `[frontendUrl, 'http://localhost:3000']` with `credentials: true` — localhost is trusted in every environment. No helmet.
- No `@nestjs/throttler` or any limiter anywhere (grep-verified). Paid endpoints: `POST /review/session` (≤10 gpt-4o-mini steps + embeddings), `POST /history/:id/chat`.
- `docs/authentication.md` currently claims: Bearer-only tokens (line ~46) and "cache is bounded at 500 entries" (line ~70) — both wrong (A-31, A-32).

## 3. Findings covered

| ID | Sev | Finding |
|---|---|---|
| C-1 | 🟠 | Over-scoped OAuth: `repo` scope grants full private-repo access the app never uses |
| S-4 | 🟠 | `?token=` query-param auth — live GitHub tokens in URLs/logs/history |
| M-3 | 🟠 | No rate limiting / cost guardrails on paid AI endpoints |
| A-31 | 🟠 | authentication.md omits the `?token=` fallback |
| S-5 | 🟡 | Token-cache bound not enforced — unbounded growth with many live tokens |
| A-32 | 🟡 | authentication.md "bounded at 500 entries" claim is wrong |

## 4. Read first

- `apps/client/lib/auth.ts`, `apps/client/app/login/page.tsx`
- `apps/server/src/auth/auth.guard.ts`, `auth.service.ts`, `token-cache.service.ts`
- `apps/server/src/main.ts`, `apps/server/src/github/github.service.ts` (token usage)
- `docs/authentication.md`; `AUDIT-REPORT.md` §4 (S-4, S-5), §5 (C-1), §8 (M-3), §2.8 (A-31, A-32)

## 5. Tasks

1. [x] **A-31 + A-32 (ungated doc fixes, do first).** Update `docs/authentication.md`: document the `?token=` fallback **with a security warning** (tokens in URLs land in proxy/access logs, browser history, referrers), and correct the cache description ("at 500 entries, expired entries are evicted; live entries are not bounded" — or the new behavior if task 4 lands first). **Acceptance:** both claims match code.
2. [x] **C-1 — drop `repo` scope (needs Q2 = "no user-token private-PR plans").** Change scope to `'read:user user:email'` in `lib/auth.ts` and fix the misleading comment. **Acceptance:** fresh OAuth flow requests only the two scopes; login works; PR review of a public repo still works (uses server `GITHUB_TOKEN`). Note: existing users' tokens keep old scopes until re-auth — mention this in PROGRESS.md.
3. [x] **S-4 — deprecate `?token=` (needs Q5).** Phase 1 (this chunk): add a `Logger.warn` deprecation log when the query-param path is used in `auth.guard.ts`, and keep the docs warning from task 1. Removal happens later only if logs show zero usage. **Acceptance:** using `?token=` logs a deprecation warning; header path unaffected.
4. [x] **S-5 — enforce a real bound.** After evicting expired entries, if size is still ≥ 500, evict oldest-inserted entries (Map preserves insertion order) until under the cap. Update `docs/authentication.md` to match. **Acceptance:** unit test — inserting 501 live entries keeps size ≤ 500.
5. [x] **M-3 — rate limiting (needs Q3).** If the deployment is public: add `@nestjs/throttler` — global default plus stricter limits on `POST /review/session` and `POST /history/:id/chat` (suggested starting points: 10/hour and 60/hour per user; record final values in this file). Key by authenticated `userId`, not IP. **Acceptance:** exceeding the limit returns 429 with a clear message; normal flows unaffected. If Q3 = "private demo", record the decision and skip implementation.
6. [x] **M-9 (CORS sub-item).** Stop trusting localhost in prod: `origin: process.env.NODE_ENV === 'production' ? [frontendUrl] : [frontendUrl, 'http://localhost:3000']`. **Acceptance:** prod config rejects `Origin: http://localhost:3000`; dev unaffected.

## 6. Verification

```bash
pnpm build:packages && pnpm type-check
pnpm --filter server test && pnpm --filter client test
cd apps/server && npx eslint "{src,apps,libs,test}/**/*.ts"   # exit 0
pnpm --filter client lint                                     # exit 0
# Manual: sign out/in on the client and confirm the GitHub authorize screen lists only read:user + user:email
```

## 7. Guardrails

- Do not change the token-validation flow itself (GitHub `/user` + in-flight dedup + cache) — only the bound and the query-param handling.
- Do not remove `?token=` outright in this chunk — deprecation + docs only (Q5).
- Rate limiting must key on `userId`; IP-keying breaks users behind NAT and over-counts shared networks.
- Do not add helmet in this chunk unless the human asks — note it in PROGRESS.md instead.

## 8. Done checklist

- [x] Q2/Q3/Q5 answers recorded in this file
- [x] OAuth scope narrowed (or decision recorded)
- [x] `?token=` deprecation log + docs warning live
- [x] Token cache hard-bounded + tested; docs corrected
- [x] Rate limiting implemented or explicitly deferred with rationale
- [x] Prod CORS tightened
- [x] `PROGRESS.md` updated (6 findings)

## Outcome notes (2026-08-12)

- **Guard ordering (M-3):** `UserThrottlerGuard` is applied at *route* level (`@UseGuards(UserThrottlerGuard)` on the two paid methods) because Nest runs controller-level guards (`AuthGuard`) first — so `req.user.userId` is populated before the tracker keys on it. A global `APP_GUARD` registration would run *before* auth and silently degrade to IP-keying; that variant was deliberately not used. Deviation from the chunk's "global default" phrasing: the `forRoot` default throttler exists but only applies where the guard is used — exactly the two paid endpoints (SSE stream endpoints stay unthrottled).
- **Storage:** throttler uses the default in-memory storage — correct for the single Render instance; a multi-instance future needs shared (Redis) storage, noted in PROGRESS discovered/follow-ups.
- **C-1 caveat:** existing users' stored tokens keep the old `repo` scope until their next sign-in (OAuth scopes are fixed at grant time).
- **Verified:** 429 integration test (11th session request → 429, service never called), token-cache bound specs (501 live inserts → cap holds; expired-sweep; LRU refresh), type-check, server+client lint (no `--fix`) all green. Manual step left to the owner: fresh GitHub sign-in should show only `read:user` + `user:email` on the authorize screen.
