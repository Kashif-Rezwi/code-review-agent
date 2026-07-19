import { Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { RedisService } from './redis.service'

export class ReviewCancelledError extends Error {
    constructor() {
        super('Review cancelled')
        this.name = 'ReviewCancelledError'
    }
}

export class ReviewDeadlineError extends Error {
    constructor() {
        super('Review exceeded the five-minute execution deadline')
        this.name = 'ReviewDeadlineError'
    }
}

export class OperationDeadlineError extends Error {
    constructor(public readonly operation: string) {
        super(`${operation} exceeded its execution deadline`)
        this.name = 'OperationDeadlineError'
    }
}

export interface ReviewExecution {
    signal: AbortSignal
    dispose: () => Promise<void>
}

@Injectable()
export class ReviewCancellationService {
    constructor(private readonly redis: RedisService) {}

    async requestCancellation(reviewId: string): Promise<void> {
        const result = await this.redis.publisher.pipeline()
            .set(this.key(reviewId), '1', 'EX', 600)
            .publish(this.channel(reviewId), 'cancel')
            .exec()
        const error = result?.find(([pipelineError]) => pipelineError)?.[0]
        if (error) throw error
    }

    async createExecution(reviewId: string, totalMs: number): Promise<ReviewExecution> {
        const controller = new AbortController()
        let subscriber: Redis | undefined
        let disposed = false
        const cancel = () => {
            if (!controller.signal.aborted) controller.abort(new ReviewCancelledError())
        }

        if (await this.redis.publisher.exists(this.key(reviewId))) cancel()
        if (!controller.signal.aborted) {
            subscriber = this.redis.createConnection()
            subscriber.on('message', (channel) => {
                if (channel === this.channel(reviewId)) cancel()
            })
            await subscriber.subscribe(this.channel(reviewId))
            // Close the check/subscribe race: a cancellation between the first
            // GET and SUBSCRIBE is retained by the TTL key.
            if (await this.redis.publisher.exists(this.key(reviewId))) cancel()
        }

        const timer = setTimeout(() => {
            if (!controller.signal.aborted) controller.abort(new ReviewDeadlineError())
        }, totalMs)
        timer.unref()

        return {
            signal: controller.signal,
            dispose: async () => {
                if (disposed) return
                disposed = true
                clearTimeout(timer)
                if (subscriber) await subscriber.quit().catch(() => undefined)
            },
        }
    }

    private key(reviewId: string): string {
        return `review:cancel:${reviewId}`
    }

    private channel(reviewId: string): string {
        return `review:cancel:${reviewId}`
    }
}

export function operationDeadline(
    parent: AbortSignal | undefined,
    operation: string,
    timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new OperationDeadlineError(operation)), timeoutMs)
    timer.unref()
    return {
        signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
        dispose: () => clearTimeout(timer),
    }
}

export function throwSignalReason(signal: AbortSignal): never {
    throw signal.reason instanceof Error ? signal.reason : new Error('Operation aborted')
}
