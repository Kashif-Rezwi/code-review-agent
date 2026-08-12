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
