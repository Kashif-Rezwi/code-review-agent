import type { ReviewStreamEvent } from '@cra/types'
import { RedisService } from './redis.service'

export type Emit = (event: ReviewStreamEvent) => void

/**
 * Creates an event emitter backed by Redis.
 * Calls remain synchronous for orchestration ergonomics, while Redis appends are
 * serialized. Terminal paths must await flush() before returning.
 */
export function createRedisEmitter(
    redis: RedisService,
    reviewId: string,
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
                writeError = error
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
