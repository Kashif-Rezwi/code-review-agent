import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import type { Prisma } from '@prisma/client'
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
                data: { userId, type, input, status: 'PENDING' }
            })
        } catch (err) {
            this.logger.warn(`Failed to create review session: ${err instanceof Error ? err.message : err}`)
            return null
        }
    }

    async markFailed(reviewId: string, message: string) {
        if (!this.hasDb) return
        await this.prisma.review.update({
            where: { id: reviewId },
            data: { status: 'FAILED', summary: message }
        }).catch(() => null)
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
        try {
            const reviewData = {
                summary: data.summary,
                score: data.score,
                positives: data.positives,
                appliedStandards: data.appliedStandards ?? [],
                ...(traceLog && traceLog.length > 0
                    ? { traceLog: traceLog as unknown as Prisma.InputJsonValue }
                    : {}),
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
                const saved = await this.prisma.review.update({
                    where: { id: reviewId },
                    data: { ...reviewData, status: 'COMPLETE' },
                })
                return saved.id
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
        } catch (err) {
            this.logger.warn(
                `Failed to save review: ${err instanceof Error ? err.message : err}`,
            )
            return undefined
        }
    }
}
