import { Body, Controller, Post, HttpCode } from '@nestjs/common'
import { ReviewService } from './review.service'
import { CreateReviewDto } from './dto/create-review.dto'

@Controller('review')
export class ReviewController {
    constructor(private readonly reviewService: ReviewService) { }

    @Post('analyze')
    @HttpCode(200)
    async analyze(@Body() dto: CreateReviewDto) {
        return this.reviewService.analyzeCode(dto.code)
    }
}