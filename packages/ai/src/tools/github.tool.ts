import { tool } from 'ai'
import { z } from 'zod'

export const githubPRToolSchema = z.object({
    prUrl: z
        .string()
        .url()
        .describe('Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/123'),
})

export type GithubPRToolInput = z.infer<typeof githubPRToolSchema>

/**
 * Factory — domain layer owns the contract (description + schema).
 * NestJS passes the implementation (HTTP calls via injected GithubService).
 */
export function createFetchGithubPRTool(
    execute: (input: GithubPRToolInput) => Promise<string>,
) {
    // @ts-expect-error TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'Fetch the unified diff of a GitHub pull request. ' +
            'Call this when the user provides a GitHub PR URL instead of pasting code directly. ' +
            'Returns the full diff of all changed files in the PR.',
        inputSchema: githubPRToolSchema,
        execute,
    })
}
