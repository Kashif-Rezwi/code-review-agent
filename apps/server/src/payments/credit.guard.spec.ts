/* eslint-disable @typescript-eslint/unbound-method */
import { ExecutionContext, HttpException, HttpStatus, InternalServerErrorException, BadRequestException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { CreditGuard } from './credit.guard'
import { PaymentsService } from './payments.service'

describe('CreditGuard', () => {
    let guard: CreditGuard
    let reflector: jest.Mocked<Reflector>
    let paymentsService: jest.Mocked<PaymentsService>

    beforeEach(() => {
        reflector = {
            get: jest.fn(),
        } as any

        paymentsService = {
            deductCredits: jest.fn(),
        } as any

        guard = new CreditGuard(reflector, paymentsService)
    })

    function createMockContext(req: any): ExecutionContext {
        return {
            getHandler: jest.fn(),
            switchToHttp: () => ({
                getRequest: () => req,
            }),
        } as any
    }

    it('CG-01: deducts credits and allows request when balance is sufficient', async () => {
        reflector.get.mockReturnValue(5)
        paymentsService.deductCredits.mockResolvedValue(20) // balanceAfter = 20

        const req: any = { user: { userId: 'user_1' } }
        const ctx = createMockContext(req)

        const { deductCredits } = paymentsService
        const result = await guard.canActivate(ctx)
        expect(result).toBe(true)
        expect(deductCredits).toHaveBeenCalledWith({
            userId: 'user_1',
            cost: 5,
            reviewId: null,
            description: expect.any(String),
        })
        expect(req.creditDeducted).toBe(5)
        expect(req.creditUserId).toBe('user_1')
    })

    it('CG-03: throws 402 PaymentRequired when balance is insufficient', async () => {
        reflector.get.mockReturnValue(10)
        paymentsService.deductCredits.mockResolvedValue(null) // null = insufficient

        const req: any = { user: { userId: 'user_1' } }
        const ctx = createMockContext(req)

        await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException)
        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
            status: HttpStatus.PAYMENT_REQUIRED,
        })
    })

    it('F-06: function resolver strictly evaluates request body or throws BadRequestException', async () => {
        const resolver = (r: any) => {
            if (r.body?.type === 'PR') return 10
            if (r.body?.type === 'CODE') return 5
            throw new BadRequestException('Invalid review type')
        }
        reflector.get.mockReturnValue(resolver)

        const invalidReq: any = { user: { userId: 'user_1' }, body: { type: 'FAKE' } }
        const ctx = createMockContext(invalidReq)

        const { deductCredits } = paymentsService
        await expect(guard.canActivate(ctx)).rejects.toThrow(BadRequestException)
        expect(deductCredits).not.toHaveBeenCalled()
    })

    it('throws 500 when AuthGuard is missing (no req.user)', async () => {
        reflector.get.mockReturnValue(5)
        const req: any = {}
        const ctx = createMockContext(req)

        await expect(guard.canActivate(ctx)).rejects.toThrow(InternalServerErrorException)
    })
})
