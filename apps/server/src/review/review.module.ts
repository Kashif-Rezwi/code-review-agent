import { Module } from '@nestjs/common'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { GithubModule } from '../github/github.module'
import { LinterModule } from '../linter/linter.module'

@Module({
  imports: [GithubModule, LinterModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule { }