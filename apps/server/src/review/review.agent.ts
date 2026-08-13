import { InternalServerErrorException, Logger } from '@nestjs/common'
import type { LanguageModel } from 'ai'
import type { ReviewData } from '@cra/types'

import {
    ProviderStreamError,
    runReviewStream,
    toProviderStreamError,
    type MinimalAiStep,
} from '../ai/ai-runtime.adapter'
import { throwSignalReason } from '../queue/review-cancellation.service'
import { parseReviewFromSteps, parseReviewText } from './review-parser.util'

const logger = new Logger('ReviewAgent')

/** Progress callbacks wired by the caller — SSE formatting stays in the service. */
export interface ReviewAgentCallbacks {
    onChunk: (arg: { chunk: unknown }) => void
    onStepFinish: (arg: { toolCalls?: unknown; toolResults?: unknown }) => void
}

export interface ReviewAgentOptions {
    model: LanguageModel
    system: string
    userMessage: string
    /** Omit for tool-free agents — no toolChoice steering is sent then. */
    tools?: Record<string, unknown>
    temperature: number
    maxOutputTokens: number
    maxSteps: number
    signal: AbortSignal
    callbacks: ReviewAgentCallbacks
}

/**
 * The single agent loop shared by the pasted-code review and the PR cluster
 * workers. Owns the AI SDK stream ceremony so call sites stay declarative:
 *
 *  - stops the loop as soon as a step parses as a valid review (saves tokens)
 *  - forces a plain-text answer on the final step when tools are in play
 *  - settles `text`/`steps`, surfacing abort reasons truthfully
 *  - captures provider stream errors and rethrows them once settled, instead
 *    of misreporting them as unparseable output
 *  - falls back to parsing earlier step texts, last-to-first
 */
export async function runReviewAgent(options: ReviewAgentOptions): Promise<ReviewData> {
    const { model, system, userMessage, tools, temperature, maxOutputTokens, maxSteps, signal, callbacks } = options
    let providerError: ProviderStreamError | undefined

    const result = runReviewStream({
        model,
        system,
        messages: [{ role: 'user', content: userMessage }],
        ...(tools ? { tools } : {}),
        temperature,
        abortSignal: signal,
        maxOutputTokens,
        stopWhen: ({ steps }: { steps: MinimalAiStep[] }) => {
            try {
                parseReviewText(steps.at(-1)?.text ?? '')
                return true
            } catch {
                return steps.length >= maxSteps
            }
        },
        // Tool-using agents must close with a text answer, not another tool call.
        ...(tools
            ? {
                prepareStep: ({ steps }: { steps: MinimalAiStep[] }) =>
                    steps.length >= maxSteps - 1 ? { toolChoice: 'none' as const } : {},
            }
            : {}),
        onChunk: callbacks.onChunk,
        onStepFinish: callbacks.onStepFinish,
        // Stream `error` parts never reach onChunk — they surface here while the
        // stream still resolves with empty text. Thrown once the stream settles.
        onError: ({ error }: { error: unknown }) => {
            providerError = toProviderStreamError(error)
        },
    })

    let finalText: string
    let steps: MinimalAiStep[]
    try {
        ;[finalText, steps] = await Promise.all([result.text, result.steps])
    } catch (error) {
        if (signal.aborted) throwSignalReason(signal)
        throw error
    }

    if (providerError) throw providerError

    try {
        return parseReviewFromSteps(finalText, steps)
    } catch {
        logger.error(
            `Review parsing failed — steps: ${steps.length}, ` +
            `last text: ${JSON.stringify(finalText.slice(0, 300))}`,
        )
        throw new InternalServerErrorException('The model did not return a valid review. Please try again.')
    }
}