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
            return await this.prisma.$transaction(async (transaction) => {
                const review = await transaction.review.create({
                    data: { userId, type, input, status: 'PENDING' },
                })
                await transaction.reviewDispatch.create({
                    data: { reviewId: review.id },
                })
                return review
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

    /**
     * Atomically transition a review to FAILED and issue a CONSUMPTION_REFUND credit ledger entry.
     * Both operations run inside a single $transaction — if either fails, neither is committed (F-05).
     *
     * Returns true if the review was actually transitioned, false if already terminal (skip refund).
     * A double-refund guard catches P2002 on the ledger insert (unique reviewId + type constraint
     * enforced at application level — we skip if a CONSUMPTION_REFUND for this review already exists).
     */
    async markFailedAndRefund(
        reviewId: string,
        message: string,
        refund: { userId: string; cost: number; description: string },
        traceLog?: ReviewStreamEvent[],
    ): Promise<boolean> {
        if (!this.hasDb) return false
        return this.prisma.$transaction(async (tx) => {
            // Step 1: Status-guard transition PENDING → FAILED.
            const result = await tx.review.updateMany({
                where: { id: reviewId, status: 'PENDING' },
                data: {
                    status: 'FAILED',
                    summary: message,
                    ...(traceLog && traceLog.length > 0 ? { traceLog: traceLog as unknown as Prisma.InputJsonValue } : {}),
                },
            })
            if (result.count === 0) return false // Already terminal — skip refund.

            // Step 2: Double-refund guard — check if a refund already exists for this review.
            const existingRefund = await tx.creditLedger.findFirst({
                where: { reviewId, type: 'CONSUMPTION_REFUND' },
                select: { id: true },
            })
            if (existingRefund) {
                this.logger.warn(`Refund for review ${reviewId} already exists — skipping double-refund (F-05)`)
                return true
            }

            // Step 3: Increment user's credit balance.
            await tx.user.updateMany({
                where: { id: refund.userId },
                data: { creditBalance: { increment: refund.cost } },
            })

            // Step 4: Read balanceAfter from DB — never compute it (F-04).
            const updatedUser = await tx.user.findUniqueOrThrow({
                where: { id: refund.userId },
                select: { creditBalance: true },
            })

            // Step 5: Append CONSUMPTION_REFUND ledger entry.
            await tx.creditLedger.create({
                data: {
                    userId: refund.userId,
                    type: 'CONSUMPTION_REFUND',
                    amount: refund.cost,
                    balanceAfter: updatedUser.creditBalance,
                    reviewId,
                    description: refund.description,
                },
            })

            return true
        }).catch((err: unknown) => {
            // P2002 = unique constraint on (reviewId, type='CONSUMPTION_REFUND') —
            // defense-in-depth (S-06). The status guard in Step 1 prevents this in
            // normal operation; the catch ensures a bug in the guard cannot double-refund.
            if ((err as { code?: string })?.code === 'P2002') return false
            throw err
        })
    }

    /**
     * Atomically transition PENDING → CANCELLED for both review and dispatch,
     * and refund deducted credits to the user's wallet (RZP-010).
     */
    async markCancelledAndRefund(
        reviewId: string,
        refund: { userId: string; cost: number; description: string },
    ): Promise<boolean> {
        if (!this.hasDb) return false
        return this.prisma.$transaction(async (tx) => {
            const result = await tx.review.updateMany({
                where: { id: reviewId, status: 'PENDING' },
                data: { status: 'CANCELLED' },
            })
            if (result.count === 0) return false // Already terminal — skip refund.

            await tx.reviewDispatch.updateMany({
                where: { reviewId, status: { in: ['PENDING', 'PROCESSING'] } },
                data: { status: 'CANCELLED', lockedUntil: null },
            })

            // Double-refund guard
            const existingRefund = await tx.creditLedger.findFirst({
                where: { reviewId, type: 'CONSUMPTION_REFUND' },
                select: { id: true },
            })
            if (existingRefund) {
                this.logger.warn(`Refund for review ${reviewId} already exists — skipping double-refund`)
                return true
            }

            // Increment user credit balance
            await tx.user.updateMany({
                where: { id: refund.userId },
                data: { creditBalance: { increment: refund.cost } },
            })

            const updatedUser = await tx.user.findUniqueOrThrow({
                where: { id: refund.userId },
                select: { creditBalance: true },
            })

            // Append CONSUMPTION_REFUND ledger entry
            await tx.creditLedger.create({
                data: {
                    userId: refund.userId,
                    type: 'CONSUMPTION_REFUND',
                    amount: refund.cost,
                    balanceAfter: updatedUser.creditBalance,
                    reviewId,
                    description: refund.description,
                },
            })

            return true
        }).catch((err: unknown) => {
            if ((err as { code?: string })?.code === 'P2002') return false
            throw err
        })
    }

    /** Returns true if the review was actually cancelled (was PENDING), false otherwise. */
    async markCancelled(reviewId: string): Promise<boolean> {
        if (!this.hasDb) return false
        return this.prisma.$transaction(async (transaction) => {
            const result = await transaction.review.updateMany({
                where: { id: reviewId, status: 'PENDING' },
                data: { status: 'CANCELLED' },
            })
            if (result.count > 0) {
                await transaction.reviewDispatch.updateMany({
                    where: { reviewId, status: { in: ['PENDING', 'PROCESSING'] } },
                    data: { status: 'CANCELLED', lockedUntil: null },
                })
            }
            return result.count > 0
        })
    }

    async saveReview(
        input: string,
        type: 'CODE' | 'PR',
        data: ReviewData & { appliedStandards?: string[] },
        userId: string,
        traceLog?: ReviewStreamEvent[],
        reviewId?: string,
        outcome: 'complete' | 'partial' = 'complete',
    ): Promise<string | undefined> {
        if (!this.hasDb) return undefined
        const reviewData = {
            summary: data.summary,
            score: data.score,
            positives: data.positives,
            appliedStandards: data.appliedStandards ?? [],
            ...(data.coverage
                ? { coverage: data.coverage as unknown as Prisma.InputJsonValue }
                : {}),
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
                    data: { ...reviewData, status: outcome === 'partial' ? 'PARTIAL' : 'COMPLETE' },
                })
                return saved.id
            } catch (err: unknown) {
                if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
                    return undefined
                }
                this.logger.error(`Failed to save review ${reviewId}: ${err instanceof Error ? err.message : String(err)}`)
                throw err
            }
        }

        const saved = await this.prisma.review.create({
            data: {
                userId,
                type,
                input,
                status: outcome === 'partial' ? 'PARTIAL' : 'COMPLETE',
                ...reviewData,
            },
        })
        return saved.id
    }
}
