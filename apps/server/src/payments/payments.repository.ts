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
        creditsGranted: number // R-02: persisted at creation time, read at capture time
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
        razorpayEventId: string
        payload: Prisma.InputJsonValue
        /** Amount paid in paise from Razorpay payload — used for cross-check (F-09). */
        amountPaidPaise: number | null
        /** Currency from Razorpay payload — used for cross-check (S-05). */
        currency: string | null
    }): Promise<'captured' | 'already_captured' | 'not_found' | 'amount_mismatch' | 'zero_credits'> {
        const { razorpayOrderId, razorpayPaymentId, razorpayEventId, payload, amountPaidPaise, currency } = params

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

            // Step 2b: Fail-closed on zero/negative credits (R-02).
            // creditsGranted was persisted at order creation time. If it is <= 0,
            // the package was removed/renamed between creation and webhook delivery,
            // or the order predates the fix. Do NOT capture — leave the order CREATED
            // for manual reconciliation and record a zero_credits event.
            if (localOrder.creditsGranted <= 0) {
                this.logger.error(
                    `[R-02] Order ${razorpayOrderId} has creditsGranted = ${localOrder.creditsGranted} (<= 0). ` +
                    'Credits NOT granted. Recording zero_credits event for reconciliation.',
                )
                await tx.paymentEvent.create({
                    data: {
                        razorpayEventId: `${razorpayEventId}_zero_credits`,
                        razorpayOrderId,
                        eventType: 'order.paid.zero_credits',
                        payload,
                    },
                })
                return 'zero_credits'
            }

            // Step 3: Amount + currency cross-check (F-09, S-02, S-05).
            // Fail-closed: a missing amount_paid is treated as a mismatch, not skipped (S-02).
            // Currency is checked when present — defense-in-depth; amount is the primary control (S-05).
            const amountMismatch = amountPaidPaise === null || localOrder.amountPaise !== amountPaidPaise
            const currencyMismatch = currency !== null && localOrder.currency !== currency
            if (amountMismatch || currencyMismatch) {
                this.logger.error(
                    `[F-09] Mismatch on order ${razorpayOrderId}: ` +
                    `expected ${localOrder.amountPaise} paise / ${localOrder.currency}, ` +
                    `got ${amountPaidPaise ?? 'missing'} paise / ${currency ?? 'missing'}. ` +
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
                data: { status: 'CAPTURED', razorpayPaymentId, creditsGranted: localOrder.creditsGranted },
            })
            if (result.count === 0) return 'already_captured'

            // Step 5: Increment creditBalance.
            await tx.user.updateMany({
                where: { id: localOrder.userId },
                data: { creditBalance: { increment: localOrder.creditsGranted } },
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
                    amount: localOrder.creditsGranted,
                    balanceAfter: updatedUser.creditBalance,
                    orderId: localOrder.id,
                    description: `Purchased ${localOrder.creditsGranted} credits`,
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
        }).catch((err: unknown) => {
            // P2002 = unique constraint on (userId, type='FREE_GRANT') — concurrent grant
            // race (S-01). The partial unique index ensures only one transaction wins;
            // the other rolls back entirely (including the balance increment).
            if ((err as { code?: string })?.code === 'P2002') return false
            throw err
        })
    }

    /**
     * Atomically refund credits after a handler failure (guard-level refund, S-03/S-04).
     * Creates its own $transaction — unlike refundCreditsInTx which must be called
     * within an existing transaction. The reviewId is null for guard/chat refunds
     * (the review may not have been created yet), so the CONSUMPTION_REFUND unique
     * index (which requires reviewId IS NOT NULL) does not apply.
     */
    async refundCredits(params: {
        userId: string
        cost: number
        reviewId: string | null
        description: string
    }): Promise<void> {
        const { userId, cost, reviewId, description } = params

        await this.prisma.$transaction(async (tx) => {
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
        })
    }

    /** Count orders with status CREATED for a user (used for pending order cap, F-11). */
    countPendingOrders(userId: string): Promise<number> {
        return this.prisma.paymentOrder.count({
            where: { userId, status: 'CREATED' },
        })
    }
}
