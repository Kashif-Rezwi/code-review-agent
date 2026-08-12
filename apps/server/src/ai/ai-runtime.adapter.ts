import { generateText, streamText } from 'ai'
import { createRunLinterTool } from '@cra/ai'
import type { LintResult } from '../linter/linter.service'

export type MinimalAiStep = { text: string }
export type MinimalStreamResult = {
    text: PromiseLike<string>
    steps: PromiseLike<MinimalAiStep[]>
}

/**
 * A provider-side failure delivered as a stream `error` chunk (billing, quota,
 * auth, …). The AI SDK resolves the stream with empty text instead of throwing,
 * so without explicit handling these surface as misleading parse failures.
 */
export class ProviderStreamError extends Error {
    constructor(
        public readonly code: string | undefined,
        detail: string | undefined,
    ) {
        super(`AI provider stream error${code ? ` [${code}]` : ''}${detail ? `: ${detail}` : ''}`)
        this.name = 'ProviderStreamError'
    }
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
