import { Body, Controller, Post, Get, Delete, Param, HttpCode, Req, UseGuards, Sse, MessageEvent, BadRequestException } from '@nestjs/common'
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

@UseGuards(AuthGuard)
@Controller('review')
export class ReviewController {
    constructor(
        private readonly reviewService: ReviewService,
        private readonly reviewStreamerService: ReviewStreamerService,
        private readonly historyService: HistoryService,
    ) { }

    @Post('session')
    @HttpCode(201)
    // Paid endpoint (LLM calls) — 10 reviews per user per hour.
    // Guard runs after the controller-level AuthGuard, so it keys on req.user.userId.
    @UseGuards(UserThrottlerGuard, CreditGuard)
    @CreditCost((req: Request) => {
        const type = (req.body as { type?: unknown } | undefined)?.type
        if (type === 'PR') return CREDIT_COSTS.PR_REVIEW
        if (type === 'CODE') return CREDIT_COSTS.CODE_REVIEW
        throw new BadRequestException('Invalid review type — must be CODE or PR')
    })
    @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
    async createSession(@Body() dto: CreateSessionDto, @Req() req: Request) {
        const review = await this.reviewService.createSession(dto.type, dto.input, req.user!.userId)
        return { reviewId: review.id }
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
        await this.historyService.getReview(reviewId, req.user!.userId)
        await this.reviewService.cancelReview(reviewId)
    }
}
