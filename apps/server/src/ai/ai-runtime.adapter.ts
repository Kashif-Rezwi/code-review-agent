import { generateText, streamText } from 'ai'
import { createRunLinterTool } from '@cra/ai'
import type { LintResult } from '../linter/linter.service'

export type MinimalAiStep = { text: string }
export type MinimalStreamResult = {
    text: PromiseLike<string>
    steps: PromiseLike<MinimalAiStep[]>
}

type RuntimeOptions = Record<string, unknown> & {
    abortSignal?: AbortSignal
    maxOutputTokens: number
}

// AI SDK's tool generics are intentionally isolated here. The rest of the
// review domain consumes only the small, stable runtime surface it needs.
const streamRuntime = streamText as unknown as (options: RuntimeOptions) => MinimalStreamResult
const generateRuntime = generateText as unknown as (
    options: RuntimeOptions,
) => Promise<{ text: string }>

export function runReviewStream(options: RuntimeOptions): MinimalStreamResult {
    return streamRuntime(options)
}

export function runReviewGenerate(options: RuntimeOptions): Promise<{ text: string }> {
    return generateRuntime(options)
}

type LinterInput = { code: string; language: 'javascript' | 'typescript'; filename?: string }

const linterRuntime = createRunLinterTool as unknown as (
    execute: (input: LinterInput) => Promise<string>,
) => unknown

/**
 * Wires the domain linter into the AI SDK tool surface.
 * `execute` returns a structured LintResult; only `output` reaches the model, so the
 * model surface stays plain text. The structured outcome is stashed in `outcomes`
 * (keyed by the exact code string) for the SSE labeler.
 */
export function createLinterRuntimeTool(
    execute: (input: LinterInput) => Promise<LintResult>,
    outcomes?: Map<string, LintResult>,
): unknown {
    return linterRuntime(async (input: LinterInput) => {
        const result = await execute(input)
        outcomes?.set(input.code, result)
        return result.output
    })
}
