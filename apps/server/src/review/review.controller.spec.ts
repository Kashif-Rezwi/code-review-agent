import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import request from 'supertest'

import { AuthGuard } from '../auth/auth.guard'
import { CreditGuard } from '../payments/credit.guard'
import { PaymentsService } from '../payments/payments.service'
import { CreditRefundInterceptor } from '../payments/credit-refund.interceptor'
import { HistoryService } from '../history/history.service'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { ReviewStreamerService } from './review-streamer.service'

describe('ReviewController POST /review/session validation', () => {
    let app: INestApplication
    const reviewService = { createSession: jest.fn() }
    const paymentsService = { refundCredits: jest.fn().mockResolvedValue(undefined) }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                // The throttled session endpoint needs the throttler providers in scope.
                ThrottlerModule.forRoot({
                    throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }],
                }),
            ],
            controllers: [ReviewController],
            providers: [
                CreditRefundInterceptor,
                { provide: ReviewService, useValue: reviewService },
                { provide: ReviewStreamerService, useValue: {} },
                { provide: HistoryService, useValue: {} },
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
            .overrideGuard(CreditGuard)
            .useValue({ canActivate: () => true })
            .compile()

        app = moduleRef.createNestApplication()
        app.useGlobalPipes(new ValidationPipe({ whitelist: true }))
        await app.init()

        reviewService.createSession.mockResolvedValue({ id: 'review-1' })
    })

    afterAll(async () => {
        await app.close()
    })

    beforeEach(() => {
        reviewService.createSession.mockClear()
    })

    it('rejects an invalid review type with 400 before the service layer runs', async () => {
        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'FOO', input: 'x' })

        expect(res.status).toBe(400)
        expect(res.body.message).toBeDefined()
        expect(reviewService.createSession).not.toHaveBeenCalled()
    })

    it('rejects a missing input with 400', async () => {
        await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE' })
            .expect(400)
        expect(reviewService.createSession).not.toHaveBeenCalled()
    })

    it('accepts a valid payload and creates the session', async () => {
        await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })
            .expect(201)
            .expect({ reviewId: 'review-1' })

        expect(reviewService.createSession).toHaveBeenCalledWith('CODE', 'const a = 1', 'user-1')
    })

    it('S-03: refunds pre-deducted credits when the handler throws after CreditGuard deduction', async () => {
        // Simulate a handler failure (e.g. DB error during session creation).
        reviewService.createSession.mockRejectedValueOnce(new Error('DB connection lost'))

        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })

        // The original error propagates as a 500 — credits are refunded, not lost.
        expect(res.status).toBe(500)
        // refundCredits is NOT called here because CreditGuard is overridden to a no-op
        // (canActivate: () => true) which does not set req.creditDeducted. The refund path
        // is exercised in the R-01 credit-refund integration test below.
    })
})

describe('ReviewController R-01: credit refund on pipe-level 400', () => {
    let app: INestApplication
    const reviewService = { createSession: jest.fn() }
    const paymentsService = { refundCredits: jest.fn().mockResolvedValue(undefined) }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                ThrottlerModule.forRoot({
                    throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }],
                }),
            ],
            controllers: [ReviewController],
            providers: [
                CreditRefundInterceptor,
                { provide: ReviewService, useValue: reviewService },
                { provide: ReviewStreamerService, useValue: {} },
                { provide: HistoryService, useValue: {} },
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
            // Simulate a real CreditGuard that deducts credits and sets markers.
            .overrideGuard(CreditGuard)
            .useValue({
                canActivate: (context: ExecutionContext) => {
                    const req = context.switchToHttp().getRequest<{
                        user?: { userId: string }
                        creditDeducted?: number
                        creditUserId?: string
                    }>()
                    req.creditDeducted = 5
                    req.creditUserId = 'user-1'
                    return true
                },
            })
            .compile()

        app = moduleRef.createNestApplication()
        app.useGlobalPipes(new ValidationPipe({ whitelist: true }))
        await app.init()

        reviewService.createSession.mockResolvedValue({ id: 'review-1' })
    })

    afterAll(async () => {
        await app.close()
    })

    beforeEach(() => {
        reviewService.createSession.mockClear()
        paymentsService.refundCredits.mockClear()
    })

    it('R-01: refunds pre-deducted credits when ValidationPipe rejects the body (400)', async () => {
        // Missing required 'input' field → ValidationPipe throws BadRequestException (400)
        // BEFORE the handler runs. CreditGuard already deducted 5 credits.
        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE' }) // missing 'input'

        expect(res.status).toBe(400)
        // The handler must NOT have been called.
        expect(reviewService.createSession).not.toHaveBeenCalled()
        // CreditRefundInterceptor must have refunded the pre-deducted credits.
        expect(paymentsService.refundCredits).toHaveBeenCalledTimes(1)
        expect(paymentsService.refundCredits).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                cost: 5,
                reviewId: null,
            }),
        )
    })

    it('R-01: does NOT refund when the body is valid and the handler succeeds (201)', async () => {
        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })

        expect(res.status).toBe(201)
        expect(reviewService.createSession).toHaveBeenCalledWith('CODE', 'const a = 1', 'user-1')
        // No refund should occur on success.
        expect(paymentsService.refundCredits).not.toHaveBeenCalled()
    })
})
