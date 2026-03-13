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
    // @ts-expect-error TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
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

export type PRFile = {
    filename: string
    status: string
    additions: number
    deletions: number
    patch?: string
}

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
    // @ts-expect-error TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'List all files changed in a GitHub PR with their individual diffs (patches). ' +
            'Prefer this over fetchGithubPR for PR reviews — it enables systematic file-by-file analysis. ' +
            'Returns filename, change status (added/modified/removed), and the diff patch per file.',
        inputSchema: listPRFilesToolSchema,
        execute,
    })
}
