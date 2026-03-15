import { tool } from 'ai'
import { z } from 'zod'

export const linterToolSchema = z.object({
    code: z.string().describe('The source code to lint'),
    language: z
        .enum(['javascript', 'typescript'])
        .describe('Language of the code — only JS/TS supported'),
    filename: z.string().optional()
        .describe('The filename being linted (e.g. cache-store.ts) — include when known'),
})

export type LinterToolInput = z.infer<typeof linterToolSchema>

// Factory: Domain owns contract. NestJS passes implementation (LinterService).

export function createRunLinterTool(
    execute: (input: LinterToolInput) => Promise<string>,
) {
    // @ts-ignore TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'Run ESLint static analysis on JavaScript or TypeScript source code. ' +
            'ONLY call this when the user has pasted source code directly — NEVER on a git diff or PR diff. ' +
            'Do NOT call this for Python, SQL, Go, or other languages — only JS/TS.',
        inputSchema: linterToolSchema,
        execute,
    })
}
