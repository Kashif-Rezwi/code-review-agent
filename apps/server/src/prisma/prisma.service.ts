import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name)

    async onModuleInit() {
        try {
            await this.$connect()
        } catch (err) {
            // DB unavailable — RAG features degrade gracefully via RagService.hasDb guard
            this.logger.warn(`Database connection failed: ${err instanceof Error ? err.message : err}`)
        }
    }

    async onModuleDestroy() {
        await this.$disconnect()
    }
}
