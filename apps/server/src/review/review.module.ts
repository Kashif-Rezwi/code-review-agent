import { Module } from '@nestjs/common'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { GithubModule } from '../github/github.module'
import { LinterModule } from '../linter/linter.module'
import { RagModule } from '../rag/rag.module'

@Module({
    imports: [GithubModule, LinterModule, RagModule],
    controllers: [ReviewController],
    providers: [ReviewService],
})
export class ReviewModule {}
