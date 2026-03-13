import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from './prisma/prisma.module'
import { RagModule } from './rag/rag.module'
import { ReviewModule } from './review/review.module'
import { HistoryModule } from './history/history.module'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RagModule,
        ReviewModule,
        HistoryModule,
    ],
})
export class AppModule {}
