import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import request from 'supertest'

import { AuthGuard } from '../auth/auth.guard'
import { CreditGuard } from '../payments/credit.guard'
import { PaymentsService } from '../payments/payments.service'
import { HistoryService } from '../history/history.service'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { ReviewStreamerService } from './review-streamer.service'

describe('POST /review/session rate limiting', () => {
    let app: INestApplication
    const reviewService = { createSession: jest.fn().mockResolvedValue({ id: 'review-1' }) }
    const paymentsService = { refundCredits: jest.fn().mockResolvedValue(undefined) }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                ThrottlerModule.forRoot({
                    errorMessage: 'Rate limit exceeded — too many requests. Please wait before trying again.',
                    throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }],
                }),
            ],
            controllers: [ReviewController],
            providers: [
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
    })

    afterAll(async () => {
        await app.close()
    })

    it('allows 10 sessions/hour per user, then returns 429 with a clear message', async () => {
        for (let i = 0; i < 10; i++) {
            await request(app.getHttpServer())
                .post('/review/session')
                .send({ type: 'CODE', input: 'const a = 1' })
                .expect(201)
        }

        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })

        expect(res.status).toBe(429)
        expect(res.text).toContain('Rate limit exceeded')
        // The 11th request never reached the service layer.
        expect(reviewService.createSession).toHaveBeenCalledTimes(10)
    })
})
