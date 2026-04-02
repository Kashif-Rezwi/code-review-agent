import { Body, Controller, Post, Get, Param, HttpCode, Req, UseGuards, Sse, MessageEvent } from '@nestjs/common'
import { Request } from 'express'
import { Observable } from 'rxjs'
import { ReviewService } from './review.service'
import { ReviewStreamerService } from './review-streamer.service'
import { AuthGuard } from '../auth/auth.guard'
import { QueueService } from '../queue/queue.service'
import { HistoryService } from '../history/history.service'

@UseGuards(AuthGuard)
@Controller('review')
export class ReviewController {
    constructor(
        private readonly reviewService: ReviewService,
        private readonly reviewStreamerService: ReviewStreamerService,
        private readonly queueService: QueueService,
        private readonly historyService: HistoryService,
    ) { }

    @Post('session')
    @HttpCode(201)
    async createSession(@Body() dto: { type: 'CODE' | 'PR'; input: string }, @Req() req: Request) {
        // Create DB record
        const review = await this.reviewService.createSession(dto.type, dto.input, req.user!.userId)

        // Push directly to BullMQ
        await this.queueService.enqueue({
            reviewId: review.id,
            type: review.type as 'CODE' | 'PR',
            input: review.input,
            userId: req.user!.userId,
        })

        return { reviewId: review.id }
    }

    @Sse(':reviewId/stream')
    streamReview(@Param('reviewId') reviewId: string, @Req() req: Request): Observable<MessageEvent> {
        return this.reviewStreamerService.createStream(reviewId, req.user!.userId)
    }

    @Get(':reviewId')
    async getReview(@Param('reviewId') reviewId: string, @Req() req: Request) {
        return this.historyService.getReview(reviewId, req.user!.userId)
    }
}