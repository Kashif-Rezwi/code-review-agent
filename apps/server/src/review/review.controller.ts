import { Body, Controller, Post, HttpCode, Res } from '@nestjs/common'
import { Response } from 'express'
import { ReviewService } from './review.service'
import { CreateReviewDto } from './dto/create-review.dto'
import { CreatePRReviewDto } from './dto/create-pr-review.dto'

@Controller('review')
export class ReviewController {
    constructor(private readonly reviewService: ReviewService) { }

    // ── Batch (non-streaming) endpoints — unchanged ───────────────────────────

    @Post('from-code')
    @HttpCode(200)
    async analyze(@Body() dto: CreateReviewDto) {
        return this.reviewService.analyzeCode(dto.code)
    }

    @Post('from-pr')
    @HttpCode(200)
    async fromPR(@Body() dto: CreatePRReviewDto) {
        return this.reviewService.analyzeFromPR(dto.prUrl)
    }

    // ── Streaming (SSE) endpoints ─────────────────────────────────────────────
    // @Res() gives us the raw Express Response so the service can write SSE
    // events directly. NestJS will not attempt to send its own response.

    @Post('from-code/stream')
    async streamAnalyze(@Body() dto: CreateReviewDto, @Res() res: Response) {
        await this.reviewService.streamAnalyzeCode(dto.code, res)
    }

    @Post('from-pr/stream')
    async streamFromPR(@Body() dto: CreatePRReviewDto, @Res() res: Response) {
        await this.reviewService.streamAnalyzeFromPR(dto.prUrl, res)
    }
}