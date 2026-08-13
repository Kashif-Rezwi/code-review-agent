import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name)

    async onModuleInit() {
        try {
            await this.$connect()
        } catch (error) {
            // Resilient boot (remediation/decisions/001): stay up so /health can report the outage
            // instead of crash-looping — Neon wake latency is routine, and Prisma reconnects lazily on later queries.
            this.logger.error(`Database connection failed at boot — continuing degraded: ${error instanceof Error ? error.message : error}`)
        }
    }

    async onModuleDestroy() {
        await this.$disconnect()
    }
}
