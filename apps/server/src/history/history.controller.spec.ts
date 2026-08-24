import { Test, TestingModule } from '@nestjs/testing'
import { ExecutionContext, NotFoundException } from '@nestjs/common'
import { ThrottlerModule } from '@nestjs/throttler'
import { HistoryController } from './history.controller'
import { HistoryService } from './history.service'
import { PaymentsService } from '../payments/payments.service'
import { RESERVES } from '../payments/credit-cost.policy'
import { AuthGuard } from '../auth/auth.guard'
import { UserThrottlerGuard } from '../throttle/user-throttler.guard'
import type { Request } from 'express'
import { lastValueFrom, toArray } from 'rxjs'

describe('HistoryController', () => {
    let controller: HistoryController
    let historyService: {
        listReviews: jest.Mock
        getStats: jest.Mock
        getReview: jest.Mock
        deleteReview: jest.Mock
        chatGenerator: jest.Mock
        computeChatCharge: jest.Mock
    }
    let paymentsService: {
        deductCredits: jest.Mock
        refundCredits: jest.Mock
        settleCredits: jest.Mock
    }

    const mockRequest = {
        user: { userId: 'user-1' },
    } as unknown as Request

    beforeEach(async () => {
        historyService = {
            listReviews: jest.fn(),
            getStats: jest.fn(),
            getReview: jest.fn(),
            deleteReview: jest.fn(),
            chatGenerator: jest.fn(),
            computeChatCharge: jest.fn(),
        }

        paymentsService = {
            deductCredits: jest.fn(),
            refundCredits: jest.fn().mockResolvedValue({ id: 'refund-1' }),
            settleCredits: jest.fn().mockResolvedValue(undefined),
        }

        const module: TestingModule = await Test.createTestingModule({
            imports: [
                ThrottlerModule.forRoot({
                    throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }],
                }),
            ],
            controllers: [HistoryController],
            providers: [
                { provide: HistoryService, useValue: historyService },
                { provide: PaymentsService, useValue: paymentsService },
            ],
        })
            .overrideGuard(AuthGuard)
            .useValue({
                canActivate: (context: ExecutionContext) => {
                    const req = context.switchToHttp().getRequest<{ user?: { userId: string } }>()
                    req.user = { userId: 'user-1' }
                    return true
                },
            })
            .overrideGuard(UserThrottlerGuard)
            .useValue({ canActivate: () => true })
            .compile()

        controller = module.get<HistoryController>(HistoryController)
    })

    it('listReviews calls historyService.listReviews', async () => {
        historyService.listReviews.mockResolvedValue([{ id: 'rev-1' }])
        const res = await controller.listReviews(mockRequest)
        expect(historyService.listReviews).toHaveBeenCalledWith('user-1')
        expect(res).toEqual([{ id: 'rev-1' }])
    })

    it('getStats calls historyService.getStats', async () => {
        historyService.getStats.mockResolvedValue({ totalReviews: 5 })
        const res = await controller.getStats(mockRequest)
        expect(historyService.getStats).toHaveBeenCalledWith('user-1')
        expect(res).toEqual({ totalReviews: 5 })
    })

    it('getReview calls historyService.getReview', async () => {
        historyService.getReview.mockResolvedValue({ id: 'rev-1', userId: 'user-1' })
        const res = await controller.getReview('rev-1', mockRequest)
        expect(historyService.getReview).toHaveBeenCalledWith('rev-1', 'user-1')
        expect(res).toEqual({ id: 'rev-1', userId: 'user-1' })
    })

    it('deleteReview calls historyService.deleteReview', async () => {
        historyService.deleteReview.mockResolvedValue(undefined)
        await controller.deleteReview('rev-1', mockRequest)
        expect(historyService.deleteReview).toHaveBeenCalledWith('rev-1', 'user-1')
    })

    describe('chat (PRD-003 & RZC-011)', () => {
        it('does NOT deduct credits or issue refunds if the review is not found / unauthorized', async () => {
            historyService.getReview.mockRejectedValue(new NotFoundException('Review rev-999 not found.'))

            const observable = controller.chat('rev-999', { message: 'Hello' }, mockRequest)
            const events = await lastValueFrom(observable.pipe(toArray()))

            expect(historyService.getReview).toHaveBeenCalledWith('rev-999', 'user-1')
            expect(paymentsService.deductCredits).not.toHaveBeenCalled()
            expect(paymentsService.refundCredits).not.toHaveBeenCalled()
            expect(historyService.chatGenerator).not.toHaveBeenCalled()

            expect(events).toEqual([
                { data: { type: 'error', message: 'Review rev-999 not found.' } },
            ])
        })

        it('returns insufficient credits error when deductCredits returns null', async () => {
            historyService.getReview.mockResolvedValue({ id: 'rev-1', userId: 'user-1' })
            paymentsService.deductCredits.mockResolvedValue(null)

            const observable = controller.chat('rev-1', { message: 'Hello' }, mockRequest)
            const events = await lastValueFrom(observable.pipe(toArray()))

            expect(historyService.getReview).toHaveBeenCalledWith('rev-1', 'user-1')
            expect(paymentsService.deductCredits).toHaveBeenCalledWith({
                userId: 'user-1',
                cost: RESERVES.CHAT,
                reviewId: 'rev-1',
                description: 'Follow-up chat query',
            })
            expect(historyService.chatGenerator).not.toHaveBeenCalled()
            expect(events).toEqual([
                { data: { type: 'error', message: 'Insufficient credits. Please top up your balance.' } },
            ])
        })

        it('reserves credits, streams response, then settles to real usage on success', async () => {
            historyService.getReview.mockResolvedValue({ id: 'rev-1', userId: 'user-1' })
            paymentsService.deductCredits.mockResolvedValue(24)
            // 3 hundredths consumed → refund the remaining 7 of the 10-hundredth reserve.
            historyService.computeChatCharge.mockReturnValue(3)

            // Simulate the real generator: report usage via the onUsage callback, then stream.
            async function* mockGenerator() {
                await Promise.resolve()
                yield 'Hello'
                yield ' world!'
            }
            historyService.chatGenerator.mockImplementation(
                (_id: string, _uid: string, _msg: string, _sig: unknown, onUsage?: (u: unknown) => void) => {
                    onUsage?.({ inputTokens: 3000, outputTokens: 500 })
                    return mockGenerator()
                },
            )

            const observable = controller.chat('rev-1', { message: 'Hello' }, mockRequest)
            const events = await lastValueFrom(observable.pipe(toArray()))

            expect(historyService.getReview).toHaveBeenCalledWith('rev-1', 'user-1')
            expect(paymentsService.deductCredits).toHaveBeenCalledWith({
                userId: 'user-1',
                cost: RESERVES.CHAT,
                reviewId: 'rev-1',
                description: 'Follow-up chat query',
            })
            // The controller forwards the captured usage to compute the charge.
            expect(historyService.computeChatCharge).toHaveBeenCalledWith({ inputTokens: 3000, outputTokens: 500 })
            expect(paymentsService.refundCredits).not.toHaveBeenCalled()
            expect(paymentsService.settleCredits).toHaveBeenCalledWith({
                userId: 'user-1',
                amount: RESERVES.CHAT - 3,
                reviewId: 'rev-1',
                description: 'Settlement: chat unused reserve',
            })

            expect(events).toEqual([
                { data: { type: 'delta', text: 'Hello' } },
                { data: { type: 'delta', text: ' world!' } },
                { data: { type: 'done' } },
            ])
        })

        it('refunds credit when stream fails before first chunk (emittedChunkCount === 0)', async () => {
            historyService.getReview.mockResolvedValue({ id: 'rev-1', userId: 'user-1' })
            paymentsService.deductCredits.mockResolvedValue(24)

            async function* failingGenerator() {
                await Promise.resolve()
                if (historyService !== null) {
                    throw new Error('LLM rate limit reached')
                }
                yield ''
            }
            historyService.chatGenerator.mockImplementation(failingGenerator)

            const observable = controller.chat('rev-1', { message: 'Hello' }, mockRequest)
            const events = await lastValueFrom(observable.pipe(toArray()))

            expect(paymentsService.deductCredits).toHaveBeenCalled()
            expect(paymentsService.refundCredits).toHaveBeenCalledWith({
                userId: 'user-1',
                cost: RESERVES.CHAT,
                reviewId: 'rev-1',
                description: 'Refund: chat stream failed',
            })

            expect(events).toEqual([
                { data: { type: 'error', message: 'LLM rate limit reached' } },
            ])
        })

        it('does NOT refund credit when stream fails after emitting chunks (partial delivery)', async () => {
            historyService.getReview.mockResolvedValue({ id: 'rev-1', userId: 'user-1' })
            paymentsService.deductCredits.mockResolvedValue(24)

            async function* partialGenerator() {
                await Promise.resolve()
                yield 'Partial text delivered'
                throw new Error('Provider connection cut')
            }
            historyService.chatGenerator.mockImplementation(partialGenerator)

            const observable = controller.chat('rev-1', { message: 'Hello' }, mockRequest)
            const events = await lastValueFrom(observable.pipe(toArray()))

            expect(paymentsService.deductCredits).toHaveBeenCalled()
            expect(paymentsService.refundCredits).not.toHaveBeenCalled()

            expect(events).toEqual([
                { data: { type: 'delta', text: 'Partial text delivered' } },
                { data: { type: 'error', message: 'Provider connection cut' } },
            ])
        })
    })
})
