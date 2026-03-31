import type { ReviewStreamEvent } from '@cra/types'
import { RedisService } from './redis.service'

export type Emit = (event: ReviewStreamEvent) => void

/**
 * Creates an event emitter backed by Redis.
 * Every emitted event is appended to the replay List and published to the live Channel.
 */
export function createRedisEmitter(
    redis: RedisService,
    reviewId: string,
): { send: Emit; getTrace: () => ReviewStreamEvent[]; startedAt: number } {
    const trace: ReviewStreamEvent[] = []

    return {
        send: (event: ReviewStreamEvent) => {
            trace.push(event)
            const msg = JSON.stringify(event)
            redis.addToLog(reviewId, msg).catch(console.error)
            redis.broadcast(reviewId, msg).catch(console.error)
        },
        getTrace: () => trace,
        startedAt: Date.now(),
    }
}
