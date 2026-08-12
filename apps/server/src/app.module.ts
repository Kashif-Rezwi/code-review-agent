import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { PrismaModule } from './prisma/prisma.module'
import { RagModule } from './rag/rag.module'
import { ReviewModule } from './review/review.module'
import { HistoryModule } from './history/history.module'
import { AuthModule } from './auth/auth.module'
import { HealthController } from './health.controller'
import { QueueModule } from './queue/queue.module'
import { AiModule } from './ai/ai.module'
import { GithubModule } from './github/github.module'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        // Cost guardrail for paid AI endpoints. Limits apply only where
        // UserThrottlerGuard is used; keyed by authenticated userId.
        ThrottlerModule.forRoot({
            errorMessage: 'Rate limit exceeded — too many requests. Please wait before trying again.',
            throttlers: [{ name: 'default', ttl: 3_600_000, limit: 60 }],
        }),
        PrismaModule,
        AiModule,
        GithubModule,
        AuthModule,
        RagModule,
        ReviewModule,
        HistoryModule,
        QueueModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
