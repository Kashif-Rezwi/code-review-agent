import { embed, embedMany, generateText, streamText } from 'ai'
import type { EmbeddingModel } from 'ai'
import { createRunLinterTool } from '@cra/ai'
import type { LintResult } from '../linter/linter.service'

export type MinimalUsage = { inputTokens?: number; outputTokens?: number }
export type MinimalAiStep = { text: string; usage?: MinimalUsage }
export type MinimalStreamResult = {
    text: PromiseLike<string>
    steps: PromiseLike<MinimalAiStep[]>
}
export type MinimalChatStreamResult = {
    textStream: AsyncIterable<string>
    usage: PromiseLike<MinimalUsage>
}

/**
 * Provider-side failure delivered as a stream `error` chunk (billing, quota, auth).
 * The SDK resolves such streams with empty text instead of throwing — without this, they surface as misleading parse failures.
 */
export class ProviderStreamError extends Error {
    constructor(
        public readonly code: string | undefined,
        detail: string | undefined,
        public readonly statusCode?: number,
    ) {
        super(`AI provider stream error${code ? ` [${code}]` : ''}${detail ? `: ${detail}` : ''}`)
        this.name = 'ProviderStreamError'
    }
}

// ── Narrowing helpers shared by stream-callback normalizers ─────────────────

export function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

export function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Normalize a provider stream error into a ProviderStreamError. Providers nest the real
 * error one level down; shapes vary (OpenAI `error.code` strings vs Google RPC `error.status`).
 */
export function toProviderStreamError(error: unknown): ProviderStreamError {
    const record = asRecord(error)
    const inner = asRecord(record.error)
    const code = stringValue(inner.code) ?? stringValue(inner.status) ?? stringValue(inner.type)
        ?? stringValue(record.code) ?? stringValue(record.type)
    const detail = stringValue(inner.message) ?? stringValue(record.message)
    const statusCode = numberValue(inner.statusCode) ?? numberValue(inner.code)
        ?? numberValue(record.statusCode) ?? numberValue(record.status)
    return new ProviderStreamError(code, detail, statusCode)
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
const chatStreamRuntime = streamText as unknown as (options: RuntimeOptions) => MinimalChatStreamResult

// The SDK default (maxRetries 2) retries 429s far sooner than the provider's stated
// penalty, tripling quota burn. One retry covers blips; quota waits live in provider-backoff.ts.
const DEFAULT_MAX_RETRIES = 1

export function runReviewStream(options: RuntimeOptions): MinimalStreamResult {
    return streamRuntime({ maxRetries: DEFAULT_MAX_RETRIES, ...options })
}

export function runReviewGenerate(options: RuntimeOptions): Promise<{ text: string; usage?: MinimalUsage }> {
    return generateRuntime({ maxRetries: DEFAULT_MAX_RETRIES, ...options })
}

/**
 * Follow-up chat consumes the raw token stream. Callers must pass `onError` and re-throw
 * after the stream settles — same contract as the review pipeline, else provider failures surface as blank replies.
 */
export function runChatStream(options: RuntimeOptions): MinimalChatStreamResult {
    return chatStreamRuntime({ maxRetries: DEFAULT_MAX_RETRIES, ...options })
}

// ── Embeddings ──────────────────────────────────────────────────────────────
// `providerOptions` are provider-specific on purpose: AiService (the provider
// boundary) builds them; domain code never sees them.

type EmbedRuntimeOptions = {
    model: EmbeddingModel
    value?: string
    values?: string[]
    providerOptions?: Record<string, unknown>
    maxRetries?: number
}

const embedRuntime = embed as unknown as (options: EmbedRuntimeOptions) => Promise<{ embedding: number[] }>
const embedManyRuntime = embedMany as unknown as (options: EmbedRuntimeOptions) => Promise<{ embeddings: number[][] }>

export async function runEmbedQuery(
    model: EmbeddingModel,
    value: string,
    providerOptions: Record<string, unknown>,
): Promise<number[]> {
    const { embedding } = await embedRuntime({ model, value, providerOptions, maxRetries: DEFAULT_MAX_RETRIES })
    return embedding
}

export async function runEmbedDocuments(
    model: EmbeddingModel,
    values: string[],
    providerOptions: Record<string, unknown>,
): Promise<number[][]> {
    const { embeddings } = await embedManyRuntime({ model, values, providerOptions, maxRetries: DEFAULT_MAX_RETRIES })
    return embeddings
}

type LinterInput = { code: string; language: 'javascript' | 'typescript'; filename?: string }

const linterRuntime = createRunLinterTool as unknown as (
    execute: (input: LinterInput) => Promise<string>,
) => unknown

/**
 * Wires the domain linter into the AI SDK tool surface. Only the plain-text `output` reaches
 * the model; the structured LintResult is stashed in `outcomes` (keyed by code string) for the SSE labeler.
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
