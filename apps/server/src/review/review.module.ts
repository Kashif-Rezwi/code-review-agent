import { Module } from '@nestjs/common'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { GithubModule } from '../github/github.module'
import { LinterModule } from '../linter/linter.module'
import { RagModule } from '../rag/rag.module'
import { AuthModule } from '../auth/auth.module'

@Module({
    imports: [GithubModule, LinterModule, RagModule, AuthModule],
    controllers: [ReviewController],
    providers: [ReviewService],
})
export class ReviewModule {}
