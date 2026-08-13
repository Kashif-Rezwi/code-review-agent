import type { ReviewStreamEvent } from '@cra/types'
import { RedisService } from './redis.service'

export type Emit = (event: ReviewStreamEvent) => void

/**
 * Create a Redis-backed event emitter: `send` stays synchronous for orchestration ergonomics
 * while Redis appends are serialized; terminal paths must await flush() before returning.
 * `onWriteError` fires once on the first append failure so the caller can abort early.
 */
export function createRedisEmitter(
    redis: RedisService,
    reviewId: string,
    onWriteError?: (error: unknown) => void,
): { send: Emit; flush: () => Promise<void>; getTrace: () => ReviewStreamEvent[]; startedAt: number } {
    const trace: ReviewStreamEvent[] = []
    let queue = Promise.resolve()
    let writeError: unknown

    return {
        send: (event: ReviewStreamEvent) => {
            trace.push(event)
            const msg = JSON.stringify(event)
            queue = queue.then(async () => {
                await redis.emitEvent(reviewId, msg)
            }).catch((error: unknown) => {
                const firstFailure = writeError === undefined
                writeError = error
                if (firstFailure) onWriteError?.(error)
            })
        },
        flush: async () => {
            await queue
            if (writeError) throw writeError instanceof Error ? writeError : new Error('Redis event append failed')
        },
        getTrace: () => trace,
        startedAt: Date.now(),
    }
}
