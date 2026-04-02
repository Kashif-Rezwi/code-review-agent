# Authentication & Authorization

## Overview

Code Review Agent uses **GitHub OAuth** as its sole authentication mechanism. The Next.js frontend handles the OAuth dance via NextAuth.js and passes the resulting GitHub access token directly to the backend on every API request. The server validates the token against GitHub's `/user` API, upserts the user record, and caches the resolved identity in memory to avoid redundant API calls.

There are no server-issued JWTs or sessions — the GitHub token **is** the credential.

---

## High-Level Design

```
Browser                  Next.js (NextAuth)          NestJS Server           GitHub API
   │                           │                           │                      │
   │── Sign in with GitHub ──► │                           │                      │
   │                           │── OAuth redirect ────────────────────────────► │
   │                           │◄─ access_token ──────────────────────────────── │
   │◄── Session cookie ─────── │                           │                      │
   │                           │                           │                      │
   │── API request ──────────────────────────────────────► │                      │
   │   Authorization: Bearer <github_token>                │                      │
   │                           │                   AuthGuard intercepts           │
   │                           │                   AuthService.resolve()          │
   │                           │                           │── GET /user ────────► │
   │                           │                           │◄─ { id, login, ... } ─ │
   │                           │                    cache entry + DB upsert        │
   │                           │                    req.user = { userId, login }   │
   │◄── API response ──────────────────────────────────────│                      │
```

---

## Components

### NextAuth.js (Client)

`apps/client/lib/auth.ts` configures NextAuth with the GitHub provider. After a successful OAuth flow, NextAuth stores the GitHub access token inside the encrypted session cookie. The server-side session callback surfaces it as `session.githubToken`.

The token is then forwarded to the backend on every fetch via an `Authorization: Bearer <token>` header.

### `AuthGuard` (Server)

`apps/server/src/auth/auth.guard.ts` is a NestJS guard applied globally to the `ReviewController`, `HistoryController`, and `RagController`. It:

1. Extracts the `Authorization: Bearer <token>` header from the incoming request.
2. Calls `AuthService.resolve(token)`.
3. Attaches the resolved `{ userId, login, name, avatarUrl }` to `req.user`.
4. Returns `401 Unauthorized` if the token is missing, invalid, or expired.

The guard is applied at the controller level with `@UseGuards(AuthGuard)` — not globally — so the health-check endpoint (`GET /health`) remains unauthenticated.

### `AuthService`

`apps/server/src/auth/auth.service.ts` orchestrates token resolution with two layers of deduplication:

1. **In-memory cache** (`TokenCacheService`) — if the token was resolved within the last 5 minutes, returns immediately without hitting GitHub.
2. **In-flight map** — if multiple concurrent requests arrive with the same token while the first GitHub API call is still in flight, they all await the same promise rather than spawning parallel calls.

### `TokenCacheService`

`apps/server/src/auth/token-cache.service.ts` is a simple in-memory LRU-style store. Cache entries have a configurable TTL (default 5 minutes). Entries are keyed by the raw token string.

A resolved `CacheEntry` contains:

```
{
  userId:    string   // GitHub user ID (PK in DB)
  login:     string   // GitHub username
  name:      string | null
  avatarUrl: string | null
  expiresAt: number   // Unix ms timestamp
}
```

### `UsersService`

`apps/server/src/users/users.service.ts` exposes a single method: `findOrCreate({ id, login, name, email, avatarUrl })`. It runs an `upsert` operation keyed on the GitHub user ID. If the user already exists their profile fields are updated in case they changed their name or avatar.

---

## System Flow — First Request

1. Client sends `GET /history` with `Authorization: Bearer ghp_abc123`.
2. `AuthGuard.canActivate` fires.
3. `AuthService.resolve("ghp_abc123")` checks the token cache → miss.
4. `AuthService` checks the in-flight map → no pending promise.
5. A new `fetchAndUpsert` promise is created and stored in the in-flight map.
6. `GithubService.fetchUserProfile("ghp_abc123")` calls `https://api.github.com/user` with the token.
7. GitHub returns `{ id: 12345678, login: "kashifrezwi", ... }`.
8. `UsersService.findOrCreate(...)` upserts the user row in Postgres.
9. A `CacheEntry` is stored in `TokenCacheService` with a 5-minute TTL.
10. The in-flight promise is removed.
11. `req.user = { userId: "12345678", login: "kashifrezwi", ... }` is set.
12. The controller handler runs.

## System Flow — Subsequent Requests (within TTL)

Steps 2–12 collapse to: check cache → hit → set `req.user` → done. Zero external calls.

---

## Responsibilities

| Component | Owns |
|---|---|
| `NextAuth.js` | OAuth PKCE dance, secure session cookie, token surface |
| `AuthGuard` | HTTP header extraction, guard application, 401 responses |
| `AuthService` | Resolution lifecycle: cache → in-flight → GitHub API → DB upsert |
| `TokenCacheService` | In-memory token cache with TTL |
| `UsersService` | Database user upsert |
| `GithubService` | Raw GitHub `/user` HTTP call |

---

## Edge Cases & Error Handling

| Scenario | Behaviour |
|---|---|
| Missing `Authorization` header | `AuthGuard` returns `401` immediately |
| Invalid / expired GitHub token | `GithubService` throws `UnauthorizedException`; propagates to a `401` |
| GitHub API unavailable | `AuthService` catches the error and throws a generic `401` |
| Token shared across concurrent requests | In-flight map deduplicates; all requests resolve from the same promise |
| Cache expiry during long sessions | Next request resolves via GitHub API and refreshes the cache |
| User changes GitHub username | `findOrCreate` upserts the `login` field on every cache miss |

---

## Related Files

| File | Role |
|---|---|
| [`apps/client/lib/auth.ts`](../apps/client/lib/auth.ts) | NextAuth configuration, GitHub provider setup |
| [`apps/server/src/auth/auth.guard.ts`](../apps/server/src/auth/auth.guard.ts) | NestJS guard — extracts and validates token |
| [`apps/server/src/auth/auth.service.ts`](../apps/server/src/auth/auth.service.ts) | Resolution orchestration |
| [`apps/server/src/auth/token-cache.service.ts`](../apps/server/src/auth/token-cache.service.ts) | In-memory token cache |
| [`apps/server/src/users/users.service.ts`](../apps/server/src/users/users.service.ts) | `findOrCreate` upsert |
| [`apps/server/src/github/github.service.ts`](../apps/server/src/github/github.service.ts) | `fetchUserProfile` — raw GitHub API call |
