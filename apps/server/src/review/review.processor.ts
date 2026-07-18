import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { ReviewService } from './review.service'
import { RedisService } from '../queue/redis.service'
import { ReviewRepository } from './review.repository'
import { createRedisEmitter } from '../queue/review.emitter'
import type { ReviewJobPayload } from '../queue/queue.service'

/**
 * Executes AI pipelines in the background.
 * Part of the ReviewModule (so it can inject ReviewService without circular dependencies).
 */
@Processor('review-jobs')
export class ReviewProcessor extends WorkerHost {
    constructor(
        private readonly reviewService: ReviewService,
        private readonly redisService: RedisService,
        private readonly reviewRepository: ReviewRepository,
    ) {
        super()
    }

    /**
     * Rescues stuck jobs if BullMQ inherently terminates them (e.g. Node process stall/eviction).
     * Binds strictly to the BullMQ failed event instead of using brittle DB polling timeouts.
     */
    @OnWorkerEvent('failed')
    async onFailed(job: Job<ReviewJobPayload> | undefined, error: Error) {
        if (!job) return
        const { reviewId } = job.data
        const publicMessage = 'Background review worker failed. Please try again.'
        console.error(`Background review job ${reviewId} failed`, error)

        // Force Postgres state sync. If another terminal transition already won
        // (for example, cancellation), do not append a contradictory Redis event.
        let transitioned = false
        try {
            transitioned = await this.reviewRepository.markFailed(
                reviewId,
                publicMessage,
            )
        } catch (persistenceError) {
            console.error('Failed to persist terminal failure state', persistenceError)
            // The DB is unavailable, but the live client still needs a terminal
            // signal instead of spinning forever.
            transitioned = true
        }

        if (!transitioned) return

        // Force terminate any live SSE clients spinning in the browser
        try {
            const msg = JSON.stringify({ type: 'error', message: publicMessage })
            await this.redisService.emitEvent(reviewId, msg)
        } catch (e) {
            console.error('Failed to emit terminal failure event', e)
        }
    }

    async process(job: Job<ReviewJobPayload>): Promise<void> {
        const { reviewId, type, input, userId } = job.data

        // 1. Create a Redis-backed Emitter that perfectly implements SseConnection
        const conn = createRedisEmitter(this.redisService, reviewId)

        // 2. Run the pipeline. Errors are caught internally by runForQueue,
        // which emits { type: "error" } over Redis and updates the DB.
        // We do *not* throw to BullMQ, because we do not want it to retry expensive LLM runs.
        await this.reviewService.runForQueue(reviewId, type, input, userId, conn)
    }
}
