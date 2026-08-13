import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import request from 'supertest'

import { AuthGuard } from '../auth/auth.guard'
import { CreditGuard } from '../payments/credit.guard'
import { HistoryService } from '../history/history.service'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { ReviewStreamerService } from './review-streamer.service'

describe('ReviewController POST /review/session validation', () => {
    let app: INestApplication
    const reviewService = { createSession: jest.fn() }

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
                { provide: ReviewService, useValue: reviewService },
                { provide: ReviewStreamerService, useValue: {} },
                { provide: HistoryService, useValue: {} },
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
})
