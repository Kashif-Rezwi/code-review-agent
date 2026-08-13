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

    /** Enqueue a review job; no-op if a job with the same reviewId already exists. */
    async enqueue(payload: ReviewJobPayload): Promise<void> {
        const existing = await this.reviewQueue.getJob(payload.reviewId)
        if (existing) return
        await this.reviewQueue.add('run-pipeline', payload, {
            jobId: payload.reviewId, // Map BullMQ Job ID directly to our DB reviewId
            attempts: 1,             // LLM pipelines are expensive and non-idempotent; do not auto-retry
            removeOnComplete: { age: 3600 }, // Clean up successful jobs after 1 hour
            removeOnFail: { age: 86400 * 3 }, // Keep failed jobs in Redis for 3 days for debugging
        })
    }

    /** Remove a queued job by reviewId (= BullMQ jobId); no-ops if the job already started or was removed. */
    async removeJob(reviewId: string): Promise<void> {
        try {
            const job = await this.reviewQueue.getJob(reviewId)
            if (job) await job.remove()
        } catch {
            // Job may have already started running or been cleaned up — safe to ignore
        }
    }
}
