# GitHub PR Data Acquisition

## Purpose

`GithubService` supplies normalized per-file PR data to the review orchestrator. It is separate from GitHub sign-in: the browser session token authenticates app users, while the optional server `GITHUB_TOKEN` raises API limits and permits configured private-repository access.

The server token architecture is intentionally unchanged. A GitHub App/OAuth credential migration is a separate project.

## Normalized Snapshot

`fetchPRSnapshot(prUrl)` is the orchestration entry point:

```text
/pulls/:number/files (authenticated, then anonymous when appropriate)
                    │
                    ├─ success ── normalize files ── enrich missing patches from diff
                    │
                    └─ failure ── public .diff ── parse per-file records
```

Both branches return `PRSnapshot { files, source, complete, warnings }`. Each file contains normal GitHub metadata plus:

- `patchState`: `full | truncated | metadata_only | binary`
- `previousFilename` for renames
- a canonical patch rebuilt from parsed hunks when the public diff is used

The parser adapter is `unified-diff.parser.ts`, backed by `parse-diff@0.12.0`. Keeping the package behind an adapter prevents package-specific shapes from leaking into review planning.

## Files API

`fetchPRFiles()` follows `Link: rel="next"` pagination at 100 files per page and validates every response with `PRFileSchema`.

When a configured token is rejected, a public request is attempted for statuses where anonymous access may still work. If both fail, the thrown diagnostic retains both status-specific messages, GitHub request IDs, and rate-limit/retry headers when supplied. Responses and logs never contain the token.

## Public Unified-Diff Fallback

If the structured list cannot be acquired, `fetchPRSnapshot()` goes directly to:

```text
https://github.com/{owner}/{repo}/pull/{number}.diff
```

The response is read as a byte stream with a hard 2 MiB limit. An oversized diff without a structured file list fails with “PR too large to acquire safely”; the server never reviews an unknown prefix. HTML login pages, empty diffs and unparseable/empty file sets also fail explicitly.

When the files API succeeds but a patch is absent, the parsed diff is used only to fill the matching file. Binary files remain explicit `binary` records without invented text.

## Request Policy

All GitHub requests use:

- a 10-second timeout;
- one retry for network failures, `5xx`, `429`, and rate-limit `403` responses;
- at most two seconds of jitter/backoff;
- no same-request retry for `401` or `404`.

After an authenticated file request fails, the anonymous files attempt and public `.diff` fallback are separate steps. This preserves diagnostics without repeatedly sending a known-bad token.

## Token Health

At server startup, a status-only request to GitHub `/rate_limit` validates the configured token. This check is diagnostic and does not block public PR review.

`GET /health` returns:

```json
{
  "status": "ok",
  "githubToken": "valid"
}
```

`githubToken` is one of `valid`, `invalid`, `missing`, or `unchecked`. Invalid tokens make the aggregate status `degraded`; secrets are never returned.

## Failure Behavior

| Condition | Result |
|---|---|
| Authenticated files `401`, anonymous files succeeds | Use files API snapshot |
| Authenticated files `401`, anonymous files `403`, public diff succeeds | Use parsed public-diff snapshot and retain sanitized warnings |
| Some API patches missing | Fill matching text from parsed diff |
| Binary changed file | Keep explicit binary metadata |
| Raw diff exceeds 2 MiB and no file list exists | Fail safely |
| Token invalid but PR public | Public paths remain available |
| All acquisition paths fail | Review becomes `FAILED`; no model sees a bare PR URL |

## Main Files

| File | Role |
|---|---|
| `apps/server/src/github/github.service.ts` | HTTP, fallback, retry, byte limit and token health |
| `apps/server/src/github/github.types.ts` | `PRSnapshot` and normalized file types |
| `apps/server/src/github/unified-diff.parser.ts` | Application-owned parser adapter |
| `apps/server/src/github/github.utils.ts` | URL validation and base64 helpers |
| `packages/ai/src/schemas/pr-file.schema.ts` | `PRFileSchema` / `PRFile` — PR file validation |
