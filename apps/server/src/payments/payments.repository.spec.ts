import { PaymentsRepository } from './payments.repository'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Security-hardening tests for PaymentsRepository.
 * Covers S-01 (grantFreeCredits P2002 race), S-02 (fail-closed amount check),
 * S-05 (currency cross-check), and S-03/S-04 (guard-level refundCredits).
 */
describe('PaymentsRepository security hardening', () => {
    let repo: PaymentsRepository
    let mockTx: {
        paymentEvent: { create: jest.Mock }
        paymentOrder: { findUnique: jest.Mock; updateMany: jest.Mock }
        user: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock }
        creditLedger: { create: jest.Mock; findFirst: jest.Mock }
    }
    let prisma: { $transaction: jest.Mock }

    beforeEach(() => {
        mockTx = {
            paymentEvent: { create: jest.fn().mockResolvedValue(undefined) },
            paymentOrder: { findUnique: jest.fn(), updateMany: jest.fn() },
            user: {
                updateMany: jest.fn().mockResolvedValue(undefined),
                findUniqueOrThrow: jest.fn(),
            },
            creditLedger: { create: jest.fn().mockResolvedValue(undefined), findFirst: jest.fn() },
        }

        prisma = {
            $transaction: jest.fn((cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
        }

        repo = new PaymentsRepository(prisma as unknown as PrismaService)
    })

    const baseParams = {
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123',
        razorpayEventId: 'evt_123',
        payload: {} as any,
    }

    const localOrder = {
        id: 'local_1',
        userId: 'user_1',
        razorpayOrderId: 'order_123',
        amountPaise: 9900,
        currency: 'INR',
        creditsGranted: 50, // R-02: persisted at order creation time, read during capture
    }

    describe('captureOrder — amount + currency cross-check (S-02, S-05)', () => {
        it('S-02: returns amount_mismatch when amount_paid is missing (fail-closed)', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: null, currency: 'INR' })

            expect(result).toBe('amount_mismatch')
            expect(mockTx.user.updateMany).not.toHaveBeenCalled()
            expect(mockTx.creditLedger.create).not.toHaveBeenCalled()
        })

        it('S-02: returns amount_mismatch when amount_paid does not match local order', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 100, currency: 'INR' })

            expect(result).toBe('amount_mismatch')
            expect(mockTx.user.updateMany).not.toHaveBeenCalled()
        })

        it('S-05: returns amount_mismatch when currency does not match local order', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'USD' })

            expect(result).toBe('amount_mismatch')
            expect(mockTx.user.updateMany).not.toHaveBeenCalled()
        })

        it('returns captured when both amount and currency match', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)
            mockTx.paymentOrder.updateMany.mockResolvedValue({ count: 1 })
            mockTx.user.findUniqueOrThrow.mockResolvedValue({ creditBalance: 50 })

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('captured')
            expect(mockTx.user.updateMany).toHaveBeenCalled()
            expect(mockTx.creditLedger.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ type: 'PURCHASE', amount: 50 }),
                }),
            )
        })

        it('allows null currency — skips currency check, proceeds on amount match', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)
            mockTx.paymentOrder.updateMany.mockResolvedValue({ count: 1 })
            mockTx.user.findUniqueOrThrow.mockResolvedValue({ creditBalance: 50 })

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: null })

            expect(result).toBe('captured')
        })

        it('returns already_captured when order is no longer CREATED', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)
            mockTx.paymentOrder.updateMany.mockResolvedValue({ count: 0 })

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('already_captured')
            expect(mockTx.user.updateMany).not.toHaveBeenCalled()
        })

        it('returns not_found when no local order exists and creates event with null razorpayOrderId (RZP-002)', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(null)

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('not_found')
            expect(mockTx.paymentEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        razorpayOrderId: null,
                        eventType: 'order.paid',
                    }),
                }),
            )
        })

        it('RZP-003: transitions FAILED order to CAPTURED and grants credits on retry', async () => {
            const failedOrder = { ...localOrder, status: 'FAILED' }
            mockTx.paymentOrder.findUnique.mockResolvedValue(failedOrder)
            mockTx.paymentOrder.updateMany.mockResolvedValue({ count: 1 })
            mockTx.user.findUniqueOrThrow.mockResolvedValue({ creditBalance: 50 })

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('captured')
            expect(mockTx.paymentOrder.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { razorpayOrderId: 'order_123', status: { in: ['CREATED', 'FAILED', 'EXPIRED'] } },
                    data: expect.objectContaining({ status: 'CAPTURED', razorpayPaymentId: 'pay_123' }),
                }),
            )
            expect(mockTx.user.updateMany).toHaveBeenCalled()
            expect(mockTx.creditLedger.create).toHaveBeenCalled()
        })

        it('RZP-003: transitions EXPIRED order to CAPTURED and grants credits if paid late', async () => {
            const expiredOrder = { ...localOrder, status: 'EXPIRED' }
            mockTx.paymentOrder.findUnique.mockResolvedValue(expiredOrder)
            mockTx.paymentOrder.updateMany.mockResolvedValue({ count: 1 })
            mockTx.user.findUniqueOrThrow.mockResolvedValue({ creditBalance: 50 })

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('captured')
            expect(mockTx.paymentOrder.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { razorpayOrderId: 'order_123', status: { in: ['CREATED', 'FAILED', 'EXPIRED'] } },
                    data: expect.objectContaining({ status: 'CAPTURED' }),
                }),
            )
        })

        it('R-02: returns zero_credits when localOrder.creditsGranted <= 0 (fail-closed)', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue({ ...localOrder, creditsGranted: 0 })

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('zero_credits')
            // Credits must NOT be granted.
            expect(mockTx.user.updateMany).not.toHaveBeenCalled()
            expect(mockTx.creditLedger.create).not.toHaveBeenCalled()
            // A zero_credits event must be recorded for reconciliation.
            expect(mockTx.paymentEvent.create).toHaveBeenCalledTimes(2)
            expect(mockTx.paymentEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({ eventType: 'order.paid.zero_credits' }),
                }),
            )
        })
    })

    describe('failOrder (RZP-001, RZP-002)', () => {
        it('RZP-002: returns false and records event with null orderId when order not found', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(null)

            const result = await repo.failOrder({
                razorpayOrderId: 'order_unknown',
                razorpayEventId: 'evt_fail_unk',
                payload: {},
            })

            expect(result).toBe(false)
            expect(mockTx.paymentEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        razorpayOrderId: null,
                        eventType: 'payment.failed',
                    }),
                }),
            )
        })

        it('transitions CREATED order to FAILED', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(localOrder)
            mockTx.paymentOrder.updateMany.mockResolvedValue({ count: 1 })

            const result = await repo.failOrder({
                razorpayOrderId: 'order_123',
                razorpayEventId: 'evt_fail_123',
                payload: {},
            })

            expect(result).toBe(true)
            expect(mockTx.paymentOrder.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { razorpayOrderId: 'order_123', status: 'CREATED' },
                    data: { status: 'FAILED' },
                }),
            )
        })
    })

    describe('expireStaleOrders (RZP-004)', () => {
        it('transitions stale CREATED orders to EXPIRED', async () => {
            ;(prisma as any).paymentOrder = {
                updateMany: jest.fn().mockResolvedValue({ count: 3 }),
                count: jest.fn().mockResolvedValue(0),
            }

            const expiredCount = await repo.expireStaleOrders('user_1', 30 * 60 * 1000)
            expect(expiredCount).toBe(3)
            expect((prisma as any).paymentOrder.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        status: 'CREATED',
                        userId: 'user_1',
                    }),
                    data: { status: 'EXPIRED' },
                }),
            )
        })
    })

    describe('grantFreeCredits — P2002 race protection (S-01)', () => {
        it('S-01: catches P2002 and returns false (concurrent grant race)', async () => {
            prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' })

            const result = await repo.grantFreeCredits('user_1', 25)

            expect(result).toBe(false)
        })

        it('rethrows non-P2002 errors', async () => {
            prisma.$transaction.mockRejectedValueOnce(new Error('DB down'))

            await expect(repo.grantFreeCredits('user_1', 25)).rejects.toThrow('DB down')
        })

        it('returns false when a FREE_GRANT already exists (findFirst fast path)', async () => {
            mockTx.creditLedger.findFirst.mockResolvedValue({ id: 'existing' })

            const result = await repo.grantFreeCredits('user_1', 25)

            expect(result).toBe(false)
            expect(mockTx.user.updateMany).not.toHaveBeenCalled()
        })
    })

    describe('refundCredits — guard-level refund (S-03/S-04)', () => {
        it('creates a CONSUMPTION_REFUND ledger entry in its own transaction', async () => {
            mockTx.user.findUniqueOrThrow.mockResolvedValue({ creditBalance: 30 })

            await repo.refundCredits({
                userId: 'user_1',
                cost: 5,
                reviewId: null,
                description: 'Refund: review session creation failed',
            })

            expect(mockTx.user.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ data: { creditBalance: { increment: 5 } } }),
            )
            expect(mockTx.creditLedger.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        type: 'CONSUMPTION_REFUND',
                        amount: 5,
                        reviewId: null,
                    }),
                }),
            )
        })
    })
})


