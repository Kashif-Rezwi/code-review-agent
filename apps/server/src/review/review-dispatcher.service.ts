import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { DispatchStatus } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { QueueService } from '../queue/queue.service'
import { RedisService } from '../queue/redis.service'

const POLL_INTERVAL_MS = 2_000
const LEASE_MS = 30_000
const BATCH_SIZE = 20
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const
const MAX_DISPATCH_ATTEMPTS = RETRY_DELAYS_MS.length + 1

@Injectable()
export class ReviewDispatcherService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ReviewDispatcherService.name)
    private timer?: ReturnType<typeof setInterval>
    private running = false

    constructor(
        private readonly prisma: PrismaService,
        private readonly queue: QueueService,
        private readonly redis: RedisService,
    ) {}

    async onModuleInit(): Promise<void> {
        try {
            await this.reconcileLegacyPending()
        } catch (error) {
            // Keep the process alive so /health can report a missing migration.
            this.logger.error('Pending-review reconciliation failed', error)
        }
        this.timer = setInterval(() => void this.kick(), POLL_INTERVAL_MS)
        this.timer.unref()
        void this.kick()
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

    async kick(): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            await this.dispatchBatch()
        } catch (error) {
            this.logger.error('Review dispatch poll failed', error)
        } finally {
            this.running = false
        }
    }

    private async dispatchBatch(): Promise<void> {
        const now = new Date()
        const candidates = await this.prisma.reviewDispatch.findMany({
            where: {
                OR: [
                    { status: 'PENDING', availableAt: { lte: now } },
                    { status: 'PROCESSING', lockedUntil: { lte: now } },
                ],
            },
            orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
            take: BATCH_SIZE,
        })

        for (const candidate of candidates) {
            const claimed = await this.prisma.reviewDispatch.updateMany({
                where: {
                    id: candidate.id,
                    status: candidate.status,
                    ...(candidate.status === DispatchStatus.PENDING
                        ? { availableAt: { lte: now } }
                        : { lockedUntil: { lte: now } }),
                },
                data: {
                    status: 'PROCESSING',
                    attempts: { increment: 1 },
                    lockedUntil: new Date(Date.now() + LEASE_MS),
                },
            })
            if (claimed.count === 0) continue
            await this.dispatchClaim(candidate.reviewId, candidate.attempts + 1)
        }
    }

    private async dispatchClaim(reviewId: string, attempt: number): Promise<void> {
        const review = await this.prisma.review.findUnique({ where: { id: reviewId } })
        if (!review || review.status !== 'PENDING') {
            await this.prisma.reviewDispatch.updateMany({
                where: { reviewId, status: 'PROCESSING' },
                data: { status: review?.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED', lockedUntil: null },
            })
            return
        }

        try {
            await this.queue.enqueue({
                reviewId: review.id,
                type: review.type as 'CODE' | 'PR',
                input: review.input,
                userId: review.userId,
            })
            await this.prisma.reviewDispatch.updateMany({
                where: { reviewId, status: 'PROCESSING' },
                data: { status: 'DISPATCHED', dispatchedAt: new Date(), lockedUntil: null, lastError: null },
            })
            this.logger.log(`Dispatched review ${reviewId} on attempt ${attempt}`)
        } catch (error) {
            const message = safeError(error)
            this.logger.warn(`Dispatch attempt ${attempt} failed for ${reviewId}: ${message}`)
            if (attempt >= MAX_DISPATCH_ATTEMPTS) {
                await this.failExhausted(reviewId, message)
                return
            }

            const terminal = await this.prisma.review.findUnique({
                where: { id: reviewId },
                select: { status: true },
            })
            if (!terminal || terminal.status !== 'PENDING') {
                await this.prisma.reviewDispatch.updateMany({
                    where: { reviewId, status: 'PROCESSING' },
                    data: { status: terminal?.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED', lockedUntil: null },
                })
                return
            }

            await this.prisma.reviewDispatch.updateMany({
                where: { reviewId, status: 'PROCESSING' },
                data: {
                    status: 'PENDING',
                    lockedUntil: null,
                    lastError: message,
                    availableAt: new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]),
                },
            })
        }
    }

    private async failExhausted(reviewId: string, lastError: string): Promise<void> {
        const publicMessage = 'Review could not be queued after repeated attempts. Please try again.'
        const transitioned = await this.prisma.$transaction(async (transaction) => {
            await transaction.reviewDispatch.updateMany({
                where: { reviewId, status: 'PROCESSING' },
                data: { status: 'FAILED', lockedUntil: null, lastError },
            })
            const result = await transaction.review.updateMany({
                where: { id: reviewId, status: 'PENDING' },
                data: { status: 'FAILED', summary: publicMessage },
            })
            return result.count > 0
        })
        if (transitioned) {
            await this.redis.emitEvent(reviewId, JSON.stringify({ type: 'error', message: publicMessage }))
        }
    }

    private async reconcileLegacyPending(): Promise<void> {
        const cutoff = new Date(Date.now() - 5 * 60_000)
        const pendingWithoutDispatch = await this.prisma.review.findMany({
            where: { status: 'PENDING', dispatch: null },
            select: { id: true, createdAt: true },
        })
        const recent = pendingWithoutDispatch.filter((review) => review.createdAt >= cutoff)
        const stale = pendingWithoutDispatch.filter((review) => review.createdAt < cutoff)

        if (recent.length > 0) {
            await this.prisma.reviewDispatch.createMany({
                data: recent.map(({ id }) => ({ reviewId: id })),
                skipDuplicates: true,
            })
        }
        for (const review of stale) {
            const message = 'Review was interrupted before it could be queued. Please try again.'
            const result = await this.prisma.review.updateMany({
                where: { id: review.id, status: 'PENDING', dispatch: null },
                data: { status: 'FAILED', summary: message },
            })
            if (result.count > 0) {
                await this.redis.emitEvent(review.id, JSON.stringify({ type: 'error', message }))
            }
        }
    }
}

function safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}
