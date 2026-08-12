# Chunk 07 — Client reliability & UX

> **Status:** pending · **Findings:** C-2, C-7 (2) · **Severity mix:** 🟠1 🟡1
> **Depends on:** none · **Gated by:** nothing — executable now
> **Files touched:** `apps/client/next.config.ts`, `apps/client/lib/api.ts`, `apps/client/lib/use-chat-messages.ts`, `apps/client/lib/api.spec.ts` (or new spec), `remediation/PROGRESS.md`

## 1. Goal & why it matters

Two client failure modes that confuse users and developers: a missing `NEXT_PUBLIC_API_URL` silently turns every API call into a same-origin request that 404s against the Next.js server (a baked-in build ARG in both Docker and Vercel, so it fails *after* deploy, not at build time); and chat errors are swallowed into a generic "Sorry, something went wrong" bubble, hiding actionable server messages like a 401 expired token.

## 2. Context brief (ground truth)

- `apps/client/lib/api.ts:2` — `export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''`. `apiFetch` prepends it: with `''`, requests go same-origin. `apiErrorMessage(response)` already extracts server error text (JSON `message`/`error`, else raw text) — reuse it.
- `apps/client/next.config.ts` — has `output: 'standalone'`; Next inlines `NEXT_PUBLIC_*` at build time, so a build-time guard here catches both Docker (build ARG) and Vercel.
- `apps/client/lib/use-chat-messages.ts` — the `sendMessage` catch block (~:95-99) appends `{ role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }` regardless of the error. The stream parser already surfaces `{ type: 'error', message }` into `streamError`; thrown `Error`s from `apiFetch` carry the server's message.
- Client tests: vitest + Testing Library (`vitest.config.ts`, specs colocated in `lib/`, e.g. `api.spec.ts`, `sse.spec.ts`).

## 3. Findings covered

| ID | Sev | Finding |
|---|---|---|
| C-2 | 🟠 | `NEXT_PUBLIC_API_URL` falls back to `''` — silent same-origin 404s; no build-time guard |
| C-7 | 🟡 | `useChatMessages` swallows all errors into a generic bubble — server messages (401 etc.) never reach the user |

## 4. Read first

- `apps/client/lib/api.ts`, `apps/client/lib/use-chat-messages.ts`, `apps/client/next.config.ts`
- `apps/client/lib/api.spec.ts` (existing test style)

## 5. Tasks

1. [ ] **C-2 — fail fast.** In `next.config.ts`, throw a descriptive error at build time when `NEXT_PUBLIC_API_URL` is empty (message should name the var and where to set it). Also make `lib/api.ts`'s fallback explicit for non-build contexts: keep `?? ''` but have `apiFetch` throw `new Error('NEXT_PUBLIC_API_URL is not configured…')` when `API_URL` is empty instead of issuing a same-origin request. **Acceptance:** `pnpm --filter client build` with the var unset fails with the clear message; with it set, build passes; a unit test covers the `apiFetch` guard.
2. [ ] **C-7 — surface real errors.** In the `use-chat-messages` catch, use the caught error's message (prefix with a friendly lead-in, e.g. `Something went wrong: <message>`), falling back to the generic text only when no message exists. **Acceptance:** a mocked 401 (`apiFetch` throwing `Error('GitHub token is invalid or expired.')`) renders that text in the assistant bubble; existing tests updated/passing.

## 6. Verification

```bash
pnpm --filter client test          # green incl. new/updated specs
pnpm --filter client build         # passes WITH env; fails WITH a clear message WITHOUT it
pnpm --filter client lint          # exit 0
```

## 7. Guardrails

- Client-only chunk — no server edits.
- Do not redesign the chat error UX (toasts/retries) — just surface the real message.
- The build-time guard must not break `next dev` when the var IS set, and must not leak the URL value into error output beyond naming the variable.

## 8. Done checklist

- [ ] Build-time + runtime guards for `NEXT_PUBLIC_API_URL`
- [ ] Chat surfaces real server error messages
- [ ] Tests/lint/build green; `PROGRESS.md` updated (2 findings)
