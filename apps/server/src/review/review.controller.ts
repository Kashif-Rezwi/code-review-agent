import { Body, Controller, Post, HttpCode } from '@nestjs/common'
import { ReviewService } from './review.service'
import { CreateReviewDto } from './dto/create-review.dto'
import { CreatePRReviewDto } from './dto/create-pr-review.dto'

@Controller('review')
export class ReviewController {
    constructor(private readonly reviewService: ReviewService) { }

    @Post('analyze')
    @HttpCode(200)
    async analyze(@Body() dto: CreateReviewDto) {
        return this.reviewService.analyzeCode(dto.code)
    }

    @Post('from-pr')
    @HttpCode(200)
    async fromPR(@Body() dto: CreatePRReviewDto) {
        return this.reviewService.analyzeFromPR(dto.prUrl)
    }
}