import type { Response } from 'express'
import type { ReviewStreamEvent } from '@cra/types'

export interface SseConnection {
    /** Write a JSON stringified event to the stream */
    send: (event: ReviewStreamEvent) => void
    /** Timestamp when the connection was established */
    startedAt: number
}

/**
 * Configure basic Server-Sent Events headers on the response and
 * return a bound send method + start timestamp.
 */
export function initSse(res: Response): SseConnection {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    return {
        send: (event: ReviewStreamEvent) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        },
        startedAt: Date.now(),
    }
}
