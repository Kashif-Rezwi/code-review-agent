import { Processor, WorkerHost } from '@nestjs/bullmq'
import { OnModuleInit } from '@nestjs/common'
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
export class ReviewProcessor extends WorkerHost implements OnModuleInit {
    constructor(
        private readonly reviewService: ReviewService,
        private readonly redisService: RedisService,
        private readonly prisma: PrismaService,
    ) {
        super()
    }

    /**
     * Clean up stuck jobs if the server crashes while a review is RUNNING/PENDING.
     * BullMQ will retry/handle its own internal jobs, but this fixes the Postgres state.
     */
    async onModuleInit() {
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000)
        await this.prisma.review.updateMany({
            where: { status: 'PENDING', createdAt: { lt: thirtyMinsAgo } },
            data: { status: 'FAILED', summary: 'Review did not complete — server restarted.' },
        }).catch(() => null)
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
