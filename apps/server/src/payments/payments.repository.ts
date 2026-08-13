import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { Prisma } from '@prisma/client'

@Injectable()
export class PaymentsRepository {
    private readonly logger = new Logger(PaymentsRepository.name)

    constructor(private readonly prisma: PrismaService) {}

    /** Insert a new PaymentOrder row. Throws on DB error — caller handles. */
    async createOrder(data: {
        id: string
        userId: string
        razorpayOrderId: string
        packageId: string
        amountPaise: number
        currency: string
    }) {
        return this.prisma.paymentOrder.create({ data })
    }

    /** Look up a local PaymentOrder by its Razorpay order ID. Returns null if not found. */
    findOrderByRazorpayId(razorpayOrderId: string) {
        return this.prisma.paymentOrder.findUnique({
            where: { razorpayOrderId },
        })
    }

    /**
     * Atomically capture an order and credit the user's wallet.
     * Runs entirely inside a single interactive $transaction.
     *
     * Returns 'captured' if the order was transitioned CREATED → CAPTURED,
     *         'already_captured' if the order was already in a terminal state,
     *         'not_found' if no order with that razorpayOrderId exists.
     */
    async captureOrder(params: {
        razorpayOrderId: string
        razorpayPaymentId: string
        creditsGranted: number
        razorpayEventId: string
        payload: Prisma.InputJsonValue
        /** Amount paid in paise from Razorpay payload — used for cross-check (F-09). */
        amountPaidPaise: number | null
    }): Promise<'captured' | 'already_captured' | 'not_found' | 'amount_mismatch'> {
        const { razorpayOrderId, razorpayPaymentId, creditsGranted, razorpayEventId, payload, amountPaidPaise } = params

        return this.prisma.$transaction(async (tx) => {
            // Step 1: Insert PaymentEvent — unique constraint on razorpayEventId is the idempotency key.
            // If this throws P2002 the event was already processed — caller catches and returns 200.
            await tx.paymentEvent.create({
                data: {
                    razorpayEventId,
                    razorpayOrderId,
                    eventType: 'order.paid',
                    payload,
                },
            })

            // Step 2: Load local order to cross-check amount (F-09).
            const localOrder = await tx.paymentOrder.findUnique({ where: { razorpayOrderId } })
            if (!localOrder) return 'not_found'

            // Step 3: Amount cross-check (F-09) — mismatch means data integrity issue.
            if (amountPaidPaise !== null && localOrder.amountPaise !== amountPaidPaise) {
                this.logger.error(
                    `[F-09] Amount mismatch on order ${razorpayOrderId}: ` +
                    `expected ${localOrder.amountPaise} paise, got ${amountPaidPaise} paise. ` +
                    'Credits NOT granted. Recording mismatch event.',
                )
                await tx.paymentEvent.create({
                    data: {
                        razorpayEventId: `${razorpayEventId}_mismatch`,
                        razorpayOrderId,
                        eventType: 'order.paid.amount_mismatch',
                        payload,
                    },
                })
                return 'amount_mismatch'
            }

            // Step 4: Status-guard transition CREATED → CAPTURED (idempotency layer 2).
            const result = await tx.paymentOrder.updateMany({
                where: { razorpayOrderId, status: 'CREATED' },
                data: { status: 'CAPTURED', razorpayPaymentId, creditsGranted },
            })
            if (result.count === 0) return 'already_captured'

            // Step 5: Increment creditBalance.
            await tx.user.updateMany({
                where: { id: localOrder.userId },
                data: { creditBalance: { increment: creditsGranted } },
            })

            // Step 6: Read balanceAfter from DB — never compute it (F-04).
            const updatedUser = await tx.user.findUniqueOrThrow({
                where: { id: localOrder.userId },
                select: { creditBalance: true },
            })

            // Step 7: Append PURCHASE ledger entry.
            await tx.creditLedger.create({
                data: {
                    userId: localOrder.userId,
                    type: 'PURCHASE',
                    amount: creditsGranted,
                    balanceAfter: updatedUser.creditBalance,
                    orderId: localOrder.id,
                    description: `Purchased ${creditsGranted} credits`,
                },
            })

            return 'captured'
        })
    }

    /**
     * Atomically transition a CREATED order to FAILED.
     * Returns true if the transition happened, false if already terminal.
     */
    async failOrder(params: {
        razorpayOrderId: string
        razorpayEventId: string
        payload: Prisma.InputJsonValue
    }): Promise<boolean> {
        const { razorpayOrderId, razorpayEventId, payload } = params

        return this.prisma.$transaction(async (tx) => {
            // Idempotency insert — catch P2002 above if already processed.
            await tx.paymentEvent.create({
                data: {
                    razorpayEventId,
                    razorpayOrderId,
                    eventType: 'payment.failed',
                    payload,
                },
            })

            // Status-guard: only transition CREATED → FAILED (F-14).
            const result = await tx.paymentOrder.updateMany({
                where: { razorpayOrderId, status: 'CREATED' },
                data: { status: 'FAILED' },
            })
            return result.count > 0
        })
    }

    /** Return credit balance and recent ledger entries for the wallet page. */
    async getWallet(userId: string) {
        const [user, ledger] = await Promise.all([
            this.prisma.user.findUnique({
                where: { id: userId },
                select: { creditBalance: true },
            }),
            this.prisma.creditLedger.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                take: 50,
                select: {
                    id: true,
                    type: true,
                    amount: true,
                    balanceAfter: true,
                    description: true,
                    createdAt: true,
                },
            }),
        ])
        return { balance: user?.creditBalance ?? 0, ledger }
    }

    /**
     * Atomically deduct credits before an expensive operation.
     * Uses conditional decrement (WHERE creditBalance >= cost) as an anti-double-spend lock (arch §5.1).
     * Returns the balanceAfter on success, or null if the balance was insufficient.
     */
    async deductCredits(params: {
        userId: string
        cost: number
        reviewId: string | null
        description: string
    }): Promise<number | null> {
        const { userId, cost, reviewId, description } = params

        return this.prisma.$transaction(async (tx) => {
            const result = await tx.user.updateMany({
                where: { id: userId, creditBalance: { gte: cost } },
                data: { creditBalance: { decrement: cost } },
            })
            if (result.count === 0) return null

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
                    reviewId,
                    description,
                },
            })

            return updatedUser.creditBalance
        })
    }

    /**
     * Atomically refund credits after a failed review.
     * Must be called from within the same transaction as markFailed (F-05).
     * Catches P2002 on CONSUMPTION_REFUND unique check if already refunded.
     */
    async refundCreditsInTx(
        tx: Prisma.TransactionClient,
        params: {
            userId: string
            cost: number
            reviewId: string
            description: string
        },
    ): Promise<void> {
        const { userId, cost, reviewId, description } = params

        await tx.user.updateMany({
            where: { id: userId },
            data: { creditBalance: { increment: cost } },
        })

        const updatedUser = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: { creditBalance: true },
        })

        await tx.creditLedger.create({
            data: {
                userId,
                type: 'CONSUMPTION_REFUND',
                amount: cost,
                balanceAfter: updatedUser.creditBalance,
                reviewId,
                description,
            },
        })
    }

    /**
     * Idempotently grant free credits on first signup.
     * Checks for an existing FREE_GRANT row first; if one exists, returns without granting.
     * The application-level check replaces the partial unique index approach (A-6).
     */
    async grantFreeCredits(userId: string, amount: number): Promise<boolean> {
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.creditLedger.findFirst({
                where: { userId, type: 'FREE_GRANT' },
                select: { id: true },
            })
            if (existing) return false // already granted

            await tx.user.updateMany({
                where: { id: userId },
                data: { creditBalance: { increment: amount } },
            })

            const updatedUser = await tx.user.findUniqueOrThrow({
                where: { id: userId },
                select: { creditBalance: true },
            })

            await tx.creditLedger.create({
                data: {
                    userId,
                    type: 'FREE_GRANT',
                    amount,
                    balanceAfter: updatedUser.creditBalance,
                    description: `Welcome gift: ${amount} free credits`,
                },
            })

            return true
        })
    }

    /** Count orders with status CREATED for a user (used for pending order cap, F-11). */
    countPendingOrders(userId: string): Promise<number> {
        return this.prisma.paymentOrder.count({
            where: { userId, status: 'CREATED' },
        })
    }
}
