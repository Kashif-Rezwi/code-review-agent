import type { Response } from 'express'
import type { ReviewStreamEvent } from '@cra/types'

export interface SseConnection {
    /** Write one SSE event to the response and append it to the trace. */
    send: (event: ReviewStreamEvent) => void
    /** Wait until all previously sent events are durably appended. */
    flush: () => Promise<void>
    /** Timestamp when the connection was established. */
    startedAt: number
    /** All events emitted so far, in order. Used for persistence after the stream ends. */
    getTrace: () => ReviewStreamEvent[]
}

/**
 * Configure Server-Sent Events headers on the response and return a
 * bound send helper, start timestamp, and a trace accessor.
 *
 * Every event emitted via `send()` is collected in a closure-scoped array
 * so the caller can pass `conn.getTrace()` to `saveReview` after streaming.
 * Each call creates its own isolated array — concurrent reviews never share state.
 */
export function initSse(res: Response): SseConnection {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const trace: ReviewStreamEvent[] = []

    return {
        send: (event: ReviewStreamEvent) => {
            trace.push(event)
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        },
        flush: () => Promise.resolve(),
        startedAt: Date.now(),
        getTrace: () => trace,
    }
}
