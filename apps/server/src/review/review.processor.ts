import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Job } from 'bullmq'
import { ReviewService } from './review.service'
import { RedisService } from '../queue/redis.service'
import { PrismaService } from '../prisma/prisma.service'
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
        private readonly prisma: PrismaService,
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

        // Force Postgres state sync
        await this.prisma.review.updateMany({
            where: { id: reviewId, status: 'PENDING' },
            data: { status: 'FAILED', summary: `Review failed unexpectedly: ${error.message}` },
        }).catch(() => null)

        // Force terminate any live SSE clients spinning in the browser
        try {
            const msg = JSON.stringify({ type: 'error', message: `Background job failed: ${error.message}` })
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
