import { HttpException, Logger } from '@nestjs/common'
import { asRecord, ProviderStreamError, stringValue } from './ai-runtime.adapter'

const logger = new Logger('ProviderBackoff')

const TRANSIENT_PATTERN = /rate.?limit|resource.?exhaust|quota|too many requests|overloaded|temporarily unavailable|service unavailable/i

/**
 * True when the failure is a transient provider condition worth retrying after
 * a delay: HTTP 429 / 5xx, or a quota/rate-limit error code. Unparseable model
 * output, validation errors and 4xx auth failures are NOT transient — and our
 * own NestJS HTTP exceptions never are (they carry a runtime `status` property
 * that would otherwise masquerade as a provider 5xx).
 */
export function isTransientProviderError(error: unknown): boolean {
    if (error instanceof HttpException) return false
    const statusCode = statusCodeOf(error)
    if (statusCode === 429) return true
    if (statusCode !== undefined && statusCode >= 500) return true
    const code = error instanceof ProviderStreamError ? error.code : undefined
    const message = error instanceof Error ? error.message : undefined
    return TRANSIENT_PATTERN.test(`${code ?? ''} ${message ?? ''}`)
}

/**
 * Sleep before retrying a failed attempt — only for transient provider errors.
 * Honors the provider's `Retry-After` header when present, otherwise exponential
 * backoff with jitter. Returns true when it actually waited; non-transient
 * failures (e.g. unparseable output) return false immediately so existing
 * immediate-retry behavior is preserved.
 */
export async function waitBeforeProviderRetry(
    error: unknown,
    attempt: number,
    options: { signal?: AbortSignal; label?: string; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<boolean> {
    if (!isTransientProviderError(error)) return false
    const base = options.baseDelayMs ?? 1_000
    const ceiling = options.maxDelayMs ?? 8_000
    const exponential = Math.min(ceiling, base * 2 ** Math.max(0, attempt - 1))
    const delay = retryAfterMs(error) ?? Math.round(exponential * (0.5 + Math.random() * 0.5))
    logger.warn(`${options.label ?? 'AI provider call'} hit a transient provider error — retrying in ${delay}ms`)
    await abortableSleep(delay, options.signal)
    return true
}

/**
 * Run `fn` with up to `attempts` tries, backing off between transient provider
 * failures. Non-transient errors are rethrown immediately.
 */
export async function withProviderRetry<T>(
    fn: () => Promise<T>,
    options: { attempts?: number; signal?: AbortSignal; label?: string } = {},
): Promise<T> {
    const attempts = options.attempts ?? 2
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn()
        } catch (error) {
            if (attempt >= attempts || !isTransientProviderError(error)) throw error
            await waitBeforeProviderRetry(error, attempt, options)
        }
    }
}

function statusCodeOf(error: unknown): number | undefined {
    if (error instanceof ProviderStreamError) return error.statusCode
    const record = asRecord(error)
    const inner = asRecord(record.error)
    for (const candidate of [record.statusCode, record.status, inner.statusCode, inner.status]) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    }
    return undefined
}

/** Parse the AI SDK's `responseHeaders['retry-after']` (seconds or HTTP-date). */
function retryAfterMs(error: unknown): number | undefined {
    const headers = asRecord(asRecord(error).responseHeaders)
    const raw = stringValue(headers['retry-after'])
    if (!raw) return undefined
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000))
    const date = Date.parse(raw)
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted'))
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        if (signal?.aborted) {
            onAbort()
            return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}