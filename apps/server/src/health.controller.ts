import { Controller, Get } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { GithubService } from './github/github.service'
import { PrismaService } from './prisma/prisma.service'
import { RedisService } from './queue/redis.service'

type HealthState = 'valid' | 'invalid' | 'unchecked'
type CachedHealth = {
    expiresAt: number
    database: HealthState
    databaseSchema: HealthState
    redis: HealthState
    redisStreams: HealthState
}

@Controller('health')
export class HealthController {
    private cache?: CachedHealth

    constructor(
        private readonly githubService: GithubService,
        private readonly prisma: PrismaService,
        private readonly redisService: RedisService,
    ) {}

    @Get()
    async check() {
        const dependencies = await this.cachedDependencies()
        const githubToken = this.githubService.getTokenHealth()
        const degraded = githubToken === 'invalid' ||
            dependencies.database !== 'valid' ||
            dependencies.databaseSchema !== 'valid' ||
            dependencies.redis !== 'valid' ||
            dependencies.redisStreams !== 'valid'

        return {
            status: degraded ? 'degraded' : 'ok',
            ...dependencies,
            githubToken,
        }
    }

    private async cachedDependencies(): Promise<Omit<CachedHealth, 'expiresAt'>> {
        if (this.cache && this.cache.expiresAt > Date.now()) {
            return {
                database: this.cache.database,
                databaseSchema: this.cache.databaseSchema,
                redis: this.cache.redis,
                redisStreams: this.cache.redisStreams,
            }
        }

        let database: HealthState = 'invalid'
        let databaseSchema: HealthState = 'invalid'
        try {
            await this.prisma.$queryRaw(Prisma.sql`SELECT 1`)
            database = 'valid'
            const rows = await this.prisma.$queryRaw<Array<{ dispatch_table: boolean; coverage_column: boolean }>>(Prisma.sql`
                SELECT
                    to_regclass('public."ReviewDispatch"') IS NOT NULL AS dispatch_table,
                    EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'Review' AND column_name = 'coverage'
                    ) AS coverage_column
            `)
            databaseSchema = rows[0]?.dispatch_table && rows[0]?.coverage_column ? 'valid' : 'invalid'
        } catch {
            database = 'invalid'
            databaseSchema = 'unchecked'
        }

        const [redisConnected, streamsSupported] = await Promise.all([
            this.redisService.checkConnection(),
            this.redisService.checkStreams(),
        ])
        this.cache = {
            expiresAt: Date.now() + 30_000,
            database,
            databaseSchema,
            redis: redisConnected ? 'valid' : 'invalid',
            redisStreams: streamsSupported ? 'valid' : 'invalid',
        }
        return { database, databaseSchema, redis: this.cache.redis, redisStreams: this.cache.redisStreams }
    }
}
