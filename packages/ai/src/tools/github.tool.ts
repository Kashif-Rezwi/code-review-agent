import { tool } from 'ai'
import { z } from 'zod'

export const githubPRToolSchema = z.object({
    prUrl: z
        .string()
        .url()
        .describe('Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123'),
})

export type GithubPRToolInput = z.infer<typeof githubPRToolSchema>

// Factory: Domain owns contract. NestJS passes implementation (GithubService).

export function createFetchGithubPRTool(
    execute: (input: GithubPRToolInput) => Promise<string>,
) {
    // @ts-ignore TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'Fetch the unified diff of a GitHub pull request as a single string. ' +
            'Use as a fallback when listPRFiles fails. ' +
            'Returns the full diff of all changed files concatenated.',
        inputSchema: githubPRToolSchema,
        execute,
    })
}

// ── listPRFiles tool ─────────────────────────────────────────────────────────

export const PRFileSchema = z.object({
    filename:  z.string(),
    status:    z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch:     z.string().optional(),
    previous_filename: z.string().optional(),
})

/** A single changed file in a GitHub PR. Derived from PRFileSchema for runtime safety. */
export type PRFile = z.infer<typeof PRFileSchema>

export const listPRFilesToolSchema = z.object({
    prUrl: z
        .string()
        .url()
        .describe('Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123'),
})

export type ListPRFilesToolInput = z.infer<typeof listPRFilesToolSchema>

export function createListPRFilesTool(
    execute: (input: ListPRFilesToolInput) => Promise<PRFile[]>,
) {
    // @ts-ignore TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'List all files changed in a GitHub PR with their individual diffs (patches). ' +
            'Prefer this over fetchGithubPR for PR reviews — it enables systematic file-by-file analysis. ' +
            'Returns filename, change status (added/modified/removed), and the diff patch per file.',
        inputSchema: listPRFilesToolSchema,
        execute,
    })
}

// ── fetchFileContent tool ─────────────────────────────────────────────────────
// Lets the agent investigate any file in the repo when the diff alone
// is not enough to assess correctness (e.g. checking a called function,
// verifying an imported type, or understanding a base class).

export const fetchFileContentSchema = z.object({
    prUrl: z
        .string()
        .url()
        .describe('The GitHub PR URL — used to identify the repository owner and name'),
    filePath: z
        .string()
        .min(1, 'filePath must not be empty')
        .describe('Path of the file to fetch relative to the repo root. E.g. src/auth/token.service.ts'),
})

export type FetchFileContentInput = z.infer<typeof fetchFileContentSchema>

export function createFetchFileContentTool(
    execute: (input: FetchFileContentInput) => Promise<string>,
) {
    // @ts-ignore TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'Fetch the full source of any file in the GitHub repository being reviewed. ' +
            'Use this when you encounter an import, function call, or type reference whose ' +
            'implementation is needed to accurately judge correctness, security, or design. ' +
            'Call only for files that are directly relevant to an identified or suspected issue. ' +
            'Do NOT call speculatively — only when the diff alone is insufficient.',
        inputSchema: fetchFileContentSchema,
        execute,
    })
}
