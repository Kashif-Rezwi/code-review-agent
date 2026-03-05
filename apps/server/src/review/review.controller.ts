import { Controller, Post, Body, Res, HttpCode } from '@nestjs/common'
import type { Response } from 'express'
import { ReviewService } from './review.service'
import { CreateReviewDto } from './dto/create-review.dto'

@Controller('review')
export class ReviewController {
    constructor(private readonly reviewService: ReviewService) { }

    @Post('stream')
    @HttpCode(200)
    async streamReview(
        @Body() body: CreateReviewDto,
        @Res() res: Response,
    ): Promise<void> {
        await this.reviewService.streamReview(body.prompt, res)
    }
}