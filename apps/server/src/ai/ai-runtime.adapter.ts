import { embed, embedMany, generateText, streamText } from 'ai'
import type { EmbeddingModel } from 'ai'
import { createRunLinterTool } from '@cra/ai'
import type { LintResult } from '../linter/linter.service'

export type MinimalAiStep = { text: string }
export type MinimalStreamResult = {
    text: PromiseLike<string>
    steps: PromiseLike<MinimalAiStep[]>
}
export type MinimalChatStreamResult = { textStream: AsyncIterable<string> }

/**
 * A provider-side failure delivered as a stream `error` chunk (billing, quota,
 * auth, …). The AI SDK resolves the stream with empty text instead of throwing,
 * so without explicit handling these surface as misleading parse failures.
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
 * Normalize a provider stream error into a ProviderStreamError.
 * Providers nest the real error one level down; shapes vary — OpenAI-style
 * `{ error: { code: 'billing_not_active', message } }` and Google RPC-style
 * `{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message } }` both occur.
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

export function runReviewStream(options: RuntimeOptions): MinimalStreamResult {
    return streamRuntime(options)
}

export function runReviewGenerate(options: RuntimeOptions): Promise<{ text: string }> {
    return generateRuntime(options)
}

/**
 * Follow-up chat consumes the raw token stream. Callers must pass `onError`
 * and re-throw the captured error after the stream settles — same contract as
 * the review pipeline, otherwise provider failures surface as blank replies.
 */
export function runChatStream(options: RuntimeOptions): MinimalChatStreamResult {
    return chatStreamRuntime(options)
}

// ── Embeddings ──────────────────────────────────────────────────────────────
// `providerOptions` are provider-specific on purpose: AiService (the provider
// boundary) builds them; domain code never sees them.

type EmbedRuntimeOptions = {
    model: EmbeddingModel
    value?: string
    values?: string[]
    providerOptions?: Record<string, unknown>
}

const embedRuntime = embed as unknown as (options: EmbedRuntimeOptions) => Promise<{ embedding: number[] }>
const embedManyRuntime = embedMany as unknown as (options: EmbedRuntimeOptions) => Promise<{ embeddings: number[][] }>

export async function runEmbedQuery(
    model: EmbeddingModel,
    value: string,
    providerOptions: Record<string, unknown>,
): Promise<number[]> {
    const { embedding } = await embedRuntime({ model, value, providerOptions })
    return embedding
}

export async function runEmbedDocuments(
    model: EmbeddingModel,
    values: string[],
    providerOptions: Record<string, unknown>,
): Promise<number[][]> {
    const { embeddings } = await embedManyRuntime({ model, values, providerOptions })
    return embeddings
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
