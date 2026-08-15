import { ExecutionContext, HttpException, HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ThrottlerModule } from '@nestjs/throttler'
import request from 'supertest'

import { AuthGuard } from '../auth/auth.guard'
import { HistoryService } from '../history/history.service'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { ReviewStreamerService } from './review-streamer.service'

describe('ReviewController POST /review/session validation & execution', () => {
    let app: INestApplication
    const reviewService = { createSession: jest.fn(), cancelReview: jest.fn() }
    const historyService = { getReview: jest.fn() }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                ThrottlerModule.forRoot({
                    throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }],
                }),
            ],
            controllers: [ReviewController],
            providers: [
                { provide: ReviewService, useValue: reviewService },
                { provide: ReviewStreamerService, useValue: {} },
                { provide: HistoryService, useValue: historyService },
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
        reviewService.cancelReview.mockClear()
        historyService.getReview.mockClear()
    })

    it('rejects an invalid review type with 400 before the service layer runs', async () => {
        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'FOO', input: 'x' })

        expect(res.status).toBe(400)
        expect(res.body.message).toBeDefined()
        expect(reviewService.createSession).not.toHaveBeenCalled()
    })

    it('rejects a missing input with 400 before the service layer runs', async () => {
        await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE' })
            .expect(400)
        expect(reviewService.createSession).not.toHaveBeenCalled()
    })

    it('accepts a valid payload and creates the session (201)', async () => {
        await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })
            .expect(201)
            .expect({ reviewId: 'review-1' })

        expect(reviewService.createSession).toHaveBeenCalledWith('CODE', 'const a = 1', 'user-1')
    })

    it('propagates 402 PaymentRequired when service throws insufficient credits', async () => {
        reviewService.createSession.mockRejectedValueOnce(
            new HttpException('Insufficient credits. Please top up your balance.', HttpStatus.PAYMENT_REQUIRED),
        )

        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })

        expect(res.status).toBe(402)
    })

    it('propagates 500 when service throws unexpected error during session creation', async () => {
        reviewService.createSession.mockRejectedValueOnce(new Error('DB connection lost'))

        const res = await request(app.getHttpServer())
            .post('/review/session')
            .send({ type: 'CODE', input: 'const a = 1' })

        expect(res.status).toBe(500)
    })

    it('RZP-010: cancels review and passes user and type for refunding', async () => {
        historyService.getReview.mockResolvedValue({ id: 'review-1', type: 'PR', userId: 'user-1' })
        reviewService.cancelReview.mockResolvedValue(undefined)

        await request(app.getHttpServer())
            .delete('/review/review-1')
            .expect(204)

        expect(historyService.getReview).toHaveBeenCalledWith('review-1', 'user-1')
        expect(reviewService.cancelReview).toHaveBeenCalledWith('review-1', 'user-1', 'PR')
    })
})

