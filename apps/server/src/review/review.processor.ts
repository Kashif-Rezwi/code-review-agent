import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { ReviewService } from './review.service'
import { RedisService } from '../queue/redis.service'
import { ReviewRepository } from './review.repository'
import { createRedisEmitter } from '../queue/review.emitter'
import type { ReviewJobPayload } from '../queue/queue.service'
import { ReviewCancellationService } from '../queue/review-cancellation.service'
import { AI_POLICY } from '../ai/ai-policy'

/** Executes AI pipelines in the background. Lives in ReviewModule so it can inject ReviewService without circular dependencies. */
@Processor('review-jobs')
export class ReviewProcessor extends WorkerHost {
    private readonly logger = new Logger(ReviewProcessor.name)

    constructor(
        private readonly reviewService: ReviewService,
        private readonly redisService: RedisService,
        private readonly reviewRepository: ReviewRepository,
        private readonly cancellation: ReviewCancellationService,
    ) {
        super()
    }

    /** Rescues jobs BullMQ terminates (e.g. process stall/eviction) via the failed event — no brittle DB polling timeouts. */
    @OnWorkerEvent('failed')
    async onFailed(job: Job<ReviewJobPayload> | undefined, error: Error) {
        if (!job) return
        const { reviewId } = job.data
        const publicMessage = 'Background review worker failed. Please try again.'
        this.logger.error(`Background review job ${reviewId} failed: ${error.message}`, error.stack)

        // Force Postgres state sync — if another terminal transition already won
        // (e.g. cancellation), do not append a contradictory Redis event.
        let transitioned = false
        try {
            transitioned = await this.reviewRepository.markFailed(
                reviewId,
                publicMessage,
            )
        } catch (persistenceError) {
            this.logger.error(
                'Failed to persist terminal failure state',
                persistenceError instanceof Error ? persistenceError.stack : String(persistenceError),
            )
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
            this.logger.error('Failed to emit terminal failure event', e instanceof Error ? e.stack : String(e))
        }
    }

    async process(job: Job<ReviewJobPayload>): Promise<void> {
        const { reviewId, type, input, userId } = job.data
        const execution = await this.cancellation.createExecution(reviewId, AI_POLICY.deadlineMs.total)

        // 1. Create a Redis-backed emitter implementing SseConnection — a dead event stream
        //    aborts the pipeline early rather than finishing an LLM run nobody observes.
        const conn = createRedisEmitter(this.redisService, reviewId, (writeError) => {
            this.logger.error(
                `Review ${reviewId} event stream append failed — aborting pipeline: ` +
                (writeError instanceof Error ? writeError.message : String(writeError)),
            )
            execution.abort(new Error('Review event stream unavailable'))
        })

        // 2. Run the pipeline. Errors are caught internally by runForQueue (emits an error
        // event over Redis + updates the DB) — never thrown to BullMQ, so it won't retry expensive LLM runs.
        try {
            await this.reviewService.runForQueue(reviewId, type, input, userId, conn, execution.signal)
        } finally {
            // A BullMQ completion must never race the terminal Stream append.
            try {
                await conn.flush()
            } finally {
                await execution.dispose()
            }
        }
    }
}
