import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { Prisma } from '@prisma/client'
import type { ReviewData } from '@cra/ai'
import type { ReviewStreamEvent } from '@cra/types'

@Injectable()
export class ReviewRepository {
    private readonly logger = new Logger(ReviewRepository.name)
    private readonly hasDb: boolean

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        this.hasDb = !!this.config.get('DATABASE_URL')
    }

    async createSession(type: 'CODE' | 'PR', input: string, userId: string) {
        if (!this.hasDb) return null
        try {
            return await this.prisma.review.create({
                data: { userId, type, input, status: 'PENDING' },
            })
        } catch (err) {
            this.logger.warn(`Failed to create review session: ${err instanceof Error ? err.message : err}`)
            return null
        }
    }

    async markFailed(reviewId: string, message: string, traceLog?: ReviewStreamEvent[]): Promise<boolean> {
        if (!this.hasDb) return false
        // Only pending reviews may transition to FAILED. This prevents a delayed
        // worker error from overwriting an already COMPLETE or CANCELLED review.
        const result = await this.prisma.review.updateMany({
            where: { id: reviewId, status: 'PENDING' },
            data: {
                status: 'FAILED',
                summary: message,
                ...(traceLog && traceLog.length > 0 ? { traceLog: traceLog as unknown as Prisma.InputJsonValue } : {}),
            },
        })
        return result.count > 0
    }

    /** Returns true if the review was actually cancelled (was PENDING), false otherwise. */
    async markCancelled(reviewId: string): Promise<boolean> {
        if (!this.hasDb) return false
        const result = await this.prisma.review.updateMany({
            where: { id: reviewId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
        })
        return result.count > 0
    }

    async saveReview(
        input: string,
        type: 'CODE' | 'PR',
        data: ReviewData & { appliedStandards?: string[] },
        userId: string,
        traceLog?: ReviewStreamEvent[],
        reviewId?: string,
    ): Promise<string | undefined> {
        if (!this.hasDb) return undefined
        const reviewData = {
            summary: data.summary,
            score: data.score,
            positives: data.positives,
            appliedStandards: data.appliedStandards ?? [],
            ...(traceLog && traceLog.length > 0 ? { traceLog: traceLog as unknown as Prisma.InputJsonValue } : {}),
            issues: {
                create: data.issues.map((i) => ({
                    type: i.type,
                    severity: i.severity,
                    title: i.title,
                    location: i.location,
                    description: i.description,
                    recommendation: i.recommendation,
                })),
            },
        }

        if (reviewId) {
            // Only PENDING may become COMPLETE. Prisma throws P2025 when the
            // review was cancelled or another terminal transition won the race.
            try {
                const saved = await this.prisma.review.update({
                    where: { id: reviewId, status: 'PENDING' },
                    data: { ...reviewData, status: 'COMPLETE' },
                })
                return saved.id
            } catch (err: unknown) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
                    return undefined
                }
                this.logger.error(`Failed to save review ${reviewId}: ${err instanceof Error ? err.message : err}`)
                throw err
            }
        }

        const saved = await this.prisma.review.create({
            data: {
                userId,
                type,
                input,
                status: 'COMPLETE',
                ...reviewData,
            },
        })
        return saved.id
    }
}
