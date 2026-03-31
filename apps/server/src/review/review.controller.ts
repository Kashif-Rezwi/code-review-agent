import { Body, Controller, Post, Get, Param, HttpCode, Res, Req, UseGuards, UnauthorizedException } from '@nestjs/common'
import { Response, Request } from 'express'
import { ReviewService } from './review.service'
import { CreateReviewDto } from './dto/create-review.dto'
import { CreatePRReviewDto } from './dto/create-pr-review.dto'
import { AuthGuard } from '../auth/auth.guard'
import { QueueService } from '../queue/queue.service'
import { HistoryService } from '../history/history.service'
import { RedisService } from '../queue/redis.service'

@UseGuards(AuthGuard)
@Controller('review')
export class ReviewController {
    constructor(
        private readonly reviewService: ReviewService,
        private readonly queueService: QueueService,
        private readonly historyService: HistoryService,
        private readonly redisService: RedisService,
    ) { }

    // ── Session & Queue Endpoint ──────────────────────────────────────────────

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

    @Get(':reviewId/stream')
    async streamReview(@Param('reviewId') reviewId: string, @Res() res: Response, @Req() req: Request) {
        const review = await this.historyService.getReview(reviewId, req.user!.userId)

        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders()

        // Replay history
        const history = await this.redisService.getLog(reviewId)
        if (history.length > 0) {
            let buffer = ''
            for (const msg of history) {
                buffer += `data: ${msg}\n\n`
            }
            res.write(buffer)
            if ((res as any).flush) (res as any).flush()
        }

        // DB Status sync (in case worker finished or crashed)
        if (review.status === 'COMPLETE' || review.status === 'FAILED') {
            // If the Redis log has expired but the DB is COMPLETE, 
            // we MUST send a terminal event so the client closes the EventSource.
            if (history.length === 0) {
                if (review.status === 'COMPLETE') {
                    res.write(`data: {"type":"complete","review":{"id":"${review.id}"}}\n\n`)
                } else {
                    res.write(`data: {"type":"error","message":"${review.summary || 'Review failed'}"}\n\n`)
                }
                if ((res as any).flush) (res as any).flush()
            }
            res.end()
            return
        }

        // Subscribe to live events
        const sub = this.redisService.createSubscriber()
        await sub.subscribe(`re:${reviewId}`)
        sub.on('message', (channel, msg) => {
            const event = JSON.parse(msg)
            res.write(`data: ${msg}\n\n`)
            if ((res as any).flush) (res as any).flush()
            if (event.type === 'complete' || event.type === 'error') {
                res.end()
                sub.quit()
            }
        })

        // Clean up on disconnect
        req.on('close', () => sub.quit())
    }

    @Get(':reviewId')
    async getReview(@Param('reviewId') reviewId: string, @Req() req: Request) {
        return this.historyService.getReview(reviewId, req.user!.userId)
    }

    // ── Batch (non-streaming) endpoints ───────────────────────────────────────

    @Post('from-code')
    @HttpCode(200)
    async analyze(@Body() dto: CreateReviewDto, @Req() req: Request) {
        return this.reviewService.analyzeCode(dto.code, req.user!.userId)
    }

    @Post('from-pr')
    @HttpCode(200)
    async fromPR(@Body() dto: CreatePRReviewDto, @Req() req: Request) {
        return this.reviewService.analyzeFromPR(dto.prUrl, req.user!.userId)
    }

    // ── Streaming (SSE) endpoints ─────────────────────────────────────────────
    // @Res() gives us the raw Express Response so the service can write SSE
    // events directly. NestJS will not attempt to send its own response.

    @Post('from-code/stream')
    async streamAnalyze(@Body() dto: CreateReviewDto, @Res() res: Response, @Req() req: Request) {
        await this.reviewService.streamAnalyzeCode(dto.code, res, req.user!.userId)
    }

    @Post('from-pr/stream')
    async streamFromPR(@Body() dto: CreatePRReviewDto, @Res() res: Response, @Req() req: Request) {
        await this.reviewService.streamAnalyzeFromPR(dto.prUrl, res, req.user!.userId)
    }
}