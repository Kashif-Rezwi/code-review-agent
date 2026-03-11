import { tool } from 'ai'
import { z } from 'zod'

export const linterToolSchema = z.object({
    code: z.string().describe('The source code to lint'),
    language: z
        .enum(['javascript', 'typescript'])
        .describe('Language of the code — only JS/TS supported'),
})

export type LinterToolInput = z.infer<typeof linterToolSchema>

// Factory: Domain owns contract. NestJS passes implementation (LinterService).

export function createRunLinterTool(
    execute: (input: LinterToolInput) => Promise<string>,
) {
    // @ts-expect-error TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
    return tool({
        description:
            'Run ESLint static analysis on JavaScript or TypeScript code. ' +
            'Use this before reviewing JS/TS code to get objective lint findings. ' +
            'Do NOT call this for Python, SQL, Go, or other languages — only JS/TS.',
        inputSchema: linterToolSchema,
        execute,
    })
}
