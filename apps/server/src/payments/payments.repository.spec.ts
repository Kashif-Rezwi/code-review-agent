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
        creditsGranted: 50,
        razorpayEventId: 'evt_123',
        payload: {} as any,
    }

    const localOrder = {
        id: 'local_1',
        userId: 'user_1',
        razorpayOrderId: 'order_123',
        amountPaise: 9900,
        currency: 'INR',
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

        it('returns not_found when no local order exists', async () => {
            mockTx.paymentOrder.findUnique.mockResolvedValue(null)

            const result = await repo.captureOrder({ ...baseParams, amountPaidPaise: 9900, currency: 'INR' })

            expect(result).toBe('not_found')
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

