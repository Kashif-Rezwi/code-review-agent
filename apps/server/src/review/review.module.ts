import { Module } from '@nestjs/common'
import { ReviewController } from './review.controller'
import { ReviewService } from './review.service'
import { ReviewRepository } from './review.repository'
import { ReviewProcessor } from './review.processor'
import { ReviewStreamerService } from './review-streamer.service'
import { GithubModule } from '../github/github.module'
import { LinterModule } from '../linter/linter.module'
import { RagModule } from '../rag/rag.module'
import { AuthModule } from '../auth/auth.module'
import { QueueModule } from '../queue/queue.module'
import { HistoryModule } from '../history/history.module'

@Module({
    imports: [GithubModule, LinterModule, RagModule, AuthModule, QueueModule, HistoryModule],
    controllers: [ReviewController],
    providers: [ReviewService, ReviewRepository, ReviewProcessor, ReviewStreamerService],
})
export class ReviewModule {}
