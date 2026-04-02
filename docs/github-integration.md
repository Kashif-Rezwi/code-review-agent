# GitHub Integration

## Overview

The GitHub integration serves two distinct purposes: authenticating users (handled by NextAuth, documented in [authentication.md](./authentication.md)) and fetching Pull Request data for review. This document covers only the PR data access layer — how the server fetches PR diffs, file lists, and individual file content from the GitHub REST API.

---

## High-Level Design

`GithubService` is a single NestJS injectable service that wraps the GitHub REST API. It is called exclusively by `ReviewService` during the PR review pipeline. It supports two authentication modes — authenticated (with a `GITHUB_TOKEN`) and unauthenticated — and handles rate limits, pagination, and error cases uniformly.

```
ReviewService
  │
  ├── assertValidPRUrl(url)       — fail-fast URL validation before the pipeline starts
  ├── fetchPRFiles(prUrl)         — returns PRFile[] (paginated)
  ├── fetchPRDiff(prUrl)          — returns full unified diff string
  └── fetchFileContent(prUrl, filePath) — returns full source of one file
```

---

## PR URL Parsing

All methods begin with `parsePRUrl(url)` from `github.utils.ts`. This function validates and deconstructs URLs of the form:

```
https://github.com/{owner}/{repo}/pull/{number}
```

It throws a `BadRequestException` immediately for any URL that does not match this pattern. This prevents the agent loop from starting with invalid input.

---

## Authentication Modes

### Authenticated (recommended)

Set `GITHUB_TOKEN` in the server environment. This token is added as `Authorization: Bearer <token>` to every API request.

- Supports **private repositories**
- Rate limit: **5,000 requests/hour**
- Diffs are fetched via the REST API with `Accept: application/vnd.github.diff`

### Unauthenticated (public repos only)

Without `GITHUB_TOKEN`, the service falls back to GitHub's direct `.diff` URL:

```
https://github.com/{owner}/{repo}/pull/{number}.diff
```

- Works for public repos only
- Not subject to the strict 60 req/hour unauthenticated API limit (direct URL path)
- More reliable in shared-IP environments (Vercel, Render, Railway)

The `buildHeaders()` private method handles the conditional auth header injection; all public methods call it transparently.

---

## Methods

### `fetchPRFiles(prUrl): PRFile[]`

Fetches the list of files changed in a PR, with per-file diff patches.

- Uses `GET /repos/{owner}/{repo}/pulls/{number}/files?per_page=100`
- **Paginates** — follows the GitHub `Link: rel="next"` header until all pages are consumed
- Each file is validated against the `PRFileSchema` Zod schema (defined in `@cra/ai`)
- Returns an array of `PRFile` objects with: `filename`, `status`, `additions`, `deletions`, `patch`

This is the primary data source for the clustered multi-agent PR review. Returned file objects flow directly into `planClusters()` and then into each worker agent's context.

### `fetchPRDiff(prUrl): string`

Fetches the complete unified diff for the PR as a single string.

- Max size: **24,000 characters** — truncated with a notice if exceeded
- Guards against HTML login pages (returned by GitHub for private repos without auth) by checking if the response starts with `<`
- Used as a fallback in the single-agent PR path when `fetchPRFiles` returns zero files

### `fetchFileContent(prUrl, filePath): string`

Fetches the full source code of a specific file from the PR's head branch.

- Uses `GET /repos/{owner}/{repo}/contents/{path}?ref={headSha}`
- Fetches the head commit SHA via `fetchPRHeadRef()` (cached in `GithubCacheService`) to ensure the correct file version is read
- Returns max **8,000 characters** — truncated with a notice if exceeded
- GitHub's Contents API returns base64-encoded file content; `decodeGitHubFileBase64()` decodes it

### `fetchUserProfile(token): GithubUserResponse`

Validates a GitHub OAuth token and fetches the user's profile.

- Used only by `AuthService` during token resolution
- Throws `UnauthorizedException` on 401 from GitHub

---

## Caching

`GithubCacheService` (`github-cache.service.ts`) maintains an in-memory cache for PR head commit SHAs. This prevents redundant API calls during a single review session when `fetchFileContent` is called multiple times for files in the same PR.

The cache is keyed by `"{owner}/{repo}/{number}"` and is not TTL-bounded (it lives for the lifetime of the process).

---

## Error Handling

All public methods call `assertOk(res, prUrl)` which maps GitHub HTTP status codes to descriptive `BadRequestException` messages:

| GitHub Status | Exception message |
|---|---|
| `404` | PR not found; check repo visibility and PR number |
| `401` / `403` | Access denied; private repos require `GITHUB_TOKEN` |
| `429` | Rate limit exceeded; set `GITHUB_TOKEN` |
| Other non-2xx | Generic `GitHub returned {status}` message |

These exceptions propagate through `ReviewService` and are caught by the pipeline's top-level try/catch, which emits an `{ type: "error" }` SSE event and marks the review as `FAILED` in the database.

---

## Edge Cases

| Scenario | Behaviour |
|---|---|
| PR with no changed files | `fetchPRFiles` returns `[]`; pipeline falls back to single-agent path with `fetchPRDiff` |
| Diff > 24,000 characters | Truncated with `[diff truncated — PR is too large to review in full]` appended |
| File > 8,000 characters | Truncated with character count notice |
| Private repo without token | HTML login page detected → `BadRequestException` with clear message |
| Missing head SHA | `fetchPRHeadRef` returns `null`; file fetched from default branch instead |
| Paginated file lists (>100 files) | All pages consumed via `Link` header iteration |

---

## Related Files

| File | Role |
|---|---|
| [`apps/server/src/github/github.service.ts`](../apps/server/src/github/github.service.ts) | Main service — all API calls |
| [`apps/server/src/github/github.utils.ts`](../apps/server/src/github/github.utils.ts) | `parsePRUrl`, `decodeGitHubFileBase64` |
| [`apps/server/src/github/github-cache.service.ts`](../apps/server/src/github/github-cache.service.ts) | In-memory PR head SHA cache |
| [`packages/ai/src/tools/github.tool.ts`](../packages/ai/src/tools/github.tool.ts) | `PRFile` type, `PRFileSchema` Zod schema, tool definitions |
