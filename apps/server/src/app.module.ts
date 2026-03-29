import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { RagModule } from './rag/rag.module'
import { ReviewModule } from './review/review.module'
import { HistoryModule } from './history/history.module'
import { AuthModule } from './auth/auth.module'
import { HealthController } from './health.controller'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RagModule,
        ReviewModule,
        HistoryModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
