import { Body, Controller, Post, Get, Delete, Param, HttpCode, Req, UseGuards, UseInterceptors, Sse, MessageEvent, BadRequestException, Logger } from '@nestjs/common'
import { Request } from 'express'
import { Observable } from 'rxjs'
import { Throttle } from '@nestjs/throttler'
import { ReviewService } from './review.service'
import { ReviewStreamerService } from './review-streamer.service'
import { AuthGuard } from '../auth/auth.guard'
import { HistoryService } from '../history/history.service'
import { UserThrottlerGuard } from '../throttle/user-throttler.guard'
import { CreateSessionDto } from './dto/create-session.dto'
import { CreditGuard } from '../payments/credit.guard'
import { CreditCost } from '../payments/credit-cost.decorator'
import { CREDIT_COSTS } from '../payments/credit-cost.policy'
import { PaymentsService } from '../payments/payments.service'
import { CreditRefundInterceptor } from '../payments/credit-refund.interceptor'

@UseGuards(AuthGuard)
@Controller('review')
export class ReviewController {
    private readonly logger = new Logger(ReviewController.name)

    constructor(
        private readonly reviewService: ReviewService,
        private readonly reviewStreamerService: ReviewStreamerService,
        private readonly historyService: HistoryService,
        private readonly paymentsService: PaymentsService,
    ) { }

    @Post('session')
    @HttpCode(201)
    // Paid endpoint (LLM calls) — 10 reviews per user per hour.
    // Guard runs after the controller-level AuthGuard, so it keys on req.user.userId.
    @UseGuards(UserThrottlerGuard, CreditGuard)
    @UseInterceptors(CreditRefundInterceptor)
    @CreditCost((req: Request) => {
        const type = (req.body as { type?: unknown } | undefined)?.type
        if (type === 'PR') return CREDIT_COSTS.PR_REVIEW
        if (type === 'CODE') return CREDIT_COSTS.CODE_REVIEW
        throw new BadRequestException('Invalid review type — must be CODE or PR')
    })
    @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
    async createSession(@Body() dto: CreateSessionDto, @Req() req: Request) {
        try {
            const review = await this.reviewService.createSession(dto.type, dto.input, req.user!.userId)
            return { reviewId: review.id }
        } catch (err) {
            // S-03: Refund pre-deducted credits if the handler failed after CreditGuard deduction.
            // CreditGuard sets req.creditDeducted / req.creditUserId only on successful deduction.
            const creditReq = req as Request & { creditDeducted?: number; creditUserId?: string }
            if (creditReq.creditDeducted && creditReq.creditUserId) {
                await this.paymentsService.refundCredits({
                    userId: creditReq.creditUserId,
                    cost: creditReq.creditDeducted,
                    reviewId: null,
                    description: 'Refund: review session creation failed',
                }).catch((refundErr: unknown) => {
                    this.logger.error(
                        `Failed to refund credits after handler error: ${refundErr instanceof Error ? refundErr.message : String(refundErr)}`,
                    )
                })
                // R-01: Clear markers so CreditRefundInterceptor doesn't double-refund
                // when the re-thrown exception propagates through its catchError.
                creditReq.creditDeducted = undefined
                creditReq.creditUserId = undefined
            }
            throw err
        }
    }

    @Sse(':reviewId/stream')
    streamReview(@Param('reviewId') reviewId: string, @Req() req: Request): Observable<MessageEvent> {
        const lastEventId = req.header('last-event-id')
        return this.reviewStreamerService.createStream(reviewId, req.user!.userId, lastEventId)
    }

    @Get(':reviewId')
    async getReview(@Param('reviewId') reviewId: string, @Req() req: Request) {
        return this.historyService.getReview(reviewId, req.user!.userId)
    }

    @Delete(':reviewId')
    @HttpCode(204)
    async cancelReview(@Param('reviewId') reviewId: string, @Req() req: Request) {
        // Ownership check — throws NotFoundException if review doesn't belong to this user
        const review = await this.historyService.getReview(reviewId, req.user!.userId)
        await this.reviewService.cancelReview(reviewId, req.user!.userId, review.type as 'CODE' | 'PR')
    }
}

