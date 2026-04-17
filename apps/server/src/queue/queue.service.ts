import { Injectable } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'

export interface ReviewJobPayload {
    reviewId: string
    type: 'CODE' | 'PR'
    input: string
    userId: string
}

@Injectable()
export class QueueService {
    constructor(
        @InjectQueue('review-jobs') private readonly reviewQueue: Queue<ReviewJobPayload>,
    ) {}

    /**
     * Enqueues a review job.
     */
    async enqueue(payload: ReviewJobPayload): Promise<void> {
        await this.reviewQueue.add('run-pipeline', payload, {
            jobId: payload.reviewId, // Map BullMQ Job ID directly to our DB reviewId
            attempts: 1,             // LLM pipelines are expensive and non-idempotent; do not auto-retry
            removeOnComplete: { age: 3600 }, // Clean up successful jobs after 1 hour
            removeOnFail: { age: 86400 * 3 }, // Keep failed jobs in Redis for 3 days for debugging
        })
    }

    /**
     * Removes a queued job by its reviewId (= BullMQ jobId).
     * No-ops silently if the job has already started or been removed.
     */
    async removeJob(reviewId: string): Promise<void> {
        try {
            const job = await this.reviewQueue.getJob(reviewId)
            if (job) await job.remove()
        } catch {
            // Job may have already started running or been cleaned up — safe to ignore
        }
    }
}
