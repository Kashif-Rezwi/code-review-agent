import { Body, Controller, Post, HttpCode, Res, Req, UseGuards } from '@nestjs/common'
import { Response, Request } from 'express'
import { ReviewService } from './review.service'
import { CreateReviewDto } from './dto/create-review.dto'
import { CreatePRReviewDto } from './dto/create-pr-review.dto'
import { AuthGuard } from '../auth/auth.guard'

@UseGuards(AuthGuard)
@Controller('review')
export class ReviewController {
    constructor(private readonly reviewService: ReviewService) { }

    // ── Batch (non-streaming) endpoints ───────────────────────────────────────

    @Post('from-code')
    @HttpCode(200)
    async analyze(@Body() dto: CreateReviewDto, @Req() req: Request) {
        return this.reviewService.analyzeCode(dto.code, (req as any).user.userId)
    }

    @Post('from-pr')
    @HttpCode(200)
    async fromPR(@Body() dto: CreatePRReviewDto, @Req() req: Request) {
        return this.reviewService.analyzeFromPR(dto.prUrl, (req as any).user.userId)
    }

    // ── Streaming (SSE) endpoints ─────────────────────────────────────────────
    // @Res() gives us the raw Express Response so the service can write SSE
    // events directly. NestJS will not attempt to send its own response.

    @Post('from-code/stream')
    async streamAnalyze(@Body() dto: CreateReviewDto, @Res() res: Response, @Req() req: Request) {
        await this.reviewService.streamAnalyzeCode(dto.code, res, (req as any).user.userId)
    }

    @Post('from-pr/stream')
    async streamFromPR(@Body() dto: CreatePRReviewDto, @Res() res: Response, @Req() req: Request) {
        await this.reviewService.streamAnalyzeFromPR(dto.prUrl, res, (req as any).user.userId)
    }
}