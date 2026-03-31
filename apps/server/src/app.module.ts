import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { RagModule } from './rag/rag.module'
import { ReviewModule } from './review/review.module'
import { HistoryModule } from './history/history.module'
import { AuthModule } from './auth/auth.module'
import { HealthController } from './health.controller'
import { QueueModule } from './queue/queue.module'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RagModule,
        ReviewModule,
        HistoryModule,
        QueueModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
