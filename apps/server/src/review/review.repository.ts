import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { Prisma } from '@prisma/client'
import { PaymentsRepository } from '../payments/payments.repository'
import type { ReviewData } from '@cra/ai'
import type { ReviewStreamEvent } from '@cra/types'

@Injectable()
export class ReviewRepository {
    private readonly logger = new Logger(ReviewRepository.name)
    private readonly hasDb: boolean

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
        private readonly paymentsRepository: PaymentsRepository,
    ) {
        this.hasDb = !!this.config.get('DATABASE_URL')
    }

    async createSession(type: 'CODE' | 'PR', input: string, userId: string, cost?: number) {
        if (!this.hasDb) return null
        return this.prisma.$transaction(async (tx) => {
            if (cost && cost > 0) {
                // Anti-double-spend conditional decrement (INV-02)
                const deducted = await tx.user.updateMany({
                    where: { id: userId, creditBalance: { gte: cost } },
                    data: { creditBalance: { decrement: cost } },
                })
                if (deducted.count === 0) {
                    throw new HttpException(
                        { statusCode: HttpStatus.PAYMENT_REQUIRED, message: 'Insufficient credits. Please top up your balance.' },
                        HttpStatus.PAYMENT_REQUIRED,
                    )
                }
            }

            const review = await tx.review.create({
                data: { userId, type, input, status: 'PENDING' },
            })
            await tx.reviewDispatch.create({
                data: { reviewId: review.id },
            })

            if (cost && cost > 0) {
                const updatedUser = await tx.user.findUniqueOrThrow({
                    where: { id: userId },
                    select: { creditBalance: true },
                })

                await tx.creditLedger.create({
                    data: {
                        userId,
                        type: 'CONSUMPTION',
                        amount: -cost,
                        balanceAfter: updatedUser.creditBalance,
                        reviewId: review.id, // RZC-003: Guaranteed link at millisecond zero!
                        description: `${type === 'PR' ? 'PR' : 'Code'} review session`,
                    },
                })
            }

            return review
        })
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
     * Delegates balance & ledger operations to PaymentsRepository.refundCreditsInTx (RZC-001, RZC-002, ADR-007).
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

            // Step 2: Delegate financial refund to PaymentsRepository inside this transaction
            await this.paymentsRepository.refundCreditsInTx(tx, {
                userId: refund.userId,
                cost: refund.cost,
                reviewId,
                description: refund.description,
            })

            return true
        }).catch((err: unknown) => {
            // P2002 = unique constraint on (reviewId, type='CONSUMPTION_REFUND') — defense-in-depth (S-06).
            if ((err as { code?: string })?.code === 'P2002') return false
            throw err
        })
    }

    /**
     * Atomically transition PENDING → CANCELLED for both review and dispatch,
     * and refund deducted credits to the user's wallet (RZP-010).
     * Delegates financial refund to PaymentsRepository.refundCreditsInTx (RZC-001, RZC-002, ADR-007).
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

            // Delegate financial refund to PaymentsRepository inside this transaction
            await this.paymentsRepository.refundCreditsInTx(tx, {
                userId: refund.userId,
                cost: refund.cost,
                reviewId,
                description: refund.description,
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
