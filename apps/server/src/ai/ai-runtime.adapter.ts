import { generateText, streamText } from 'ai'
import { createRunLinterTool } from '@cra/ai'

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

const linterRuntime = createRunLinterTool as unknown as (
    execute: (input: { code: string; language: 'javascript' | 'typescript' }) => Promise<string>,
) => unknown

export function createLinterRuntimeTool(
    execute: (input: { code: string; language: 'javascript' | 'typescript' }) => Promise<string>,
): unknown {
    return linterRuntime(execute)
}
