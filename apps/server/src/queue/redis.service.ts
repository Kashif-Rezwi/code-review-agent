import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Redis } from 'ioredis'

export interface RedisStreamEvent {
    id: string
    message: string
}

@Injectable()
export class RedisService implements OnModuleDestroy {
    public publisher: Redis
    private redisUrl: string

    constructor(config: ConfigService) {
        this.redisUrl = config.getOrThrow('REDIS_URL')
        this.publisher = new Redis(this.redisUrl)
    }

    /** Create an isolated connection for a blocking XREAD or Pub/Sub listener. */
    createConnection(): Redis {
        return new Redis(this.redisUrl)
    }

    /** Append an ordered event and refresh its replay window — Redis Streams avoid the history-read/subscription gap of List + Pub/Sub. */
    async emitEvent(reviewId: string, message: string): Promise<string> {
        const key = this.eventKey(reviewId)
        const results = await this.publisher
            .pipeline()
            .xadd(key, 'MAXLEN', '~', 5_000, '*', 'event', message)
            .expire(key, 86_400)
            .exec()

        const pipelineError = results?.find(([error]) => error)?.[0]
        const streamId = results?.[0]?.[1]
        if (pipelineError) throw pipelineError
        if (typeof streamId !== 'string') throw new Error('Redis did not return a Stream ID')
        return streamId
    }

    async readEvents(
        connection: Redis,
        reviewId: string,
        afterId: string,
        blockMs = 15_000,
        count = 100,
    ): Promise<RedisStreamEvent[]> {
        const args: Array<string | number> = ['COUNT', count]
        if (blockMs > 0) args.push('BLOCK', blockMs)
        args.push('STREAMS', this.eventKey(reviewId), afterId)

        const response = await connection.xread(...args as Parameters<Redis['xread']>) as unknown
        if (!Array.isArray(response)) return []

        const events: RedisStreamEvent[] = []
        for (const stream of response) {
            if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue
            for (const entry of stream[1]) {
                if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue
                const fields = entry[1] as unknown[]
                for (let index = 0; index < fields.length - 1; index += 2) {
                    const message = fields[index + 1]
                    if (fields[index] === 'event' && typeof message === 'string') {
                        events.push({ id: entry[0], message })
                        break
                    }
                }
            }
        }
        return events
    }

    async checkStreams(): Promise<boolean> {
        try {
            if (await this.publisher.ping() !== 'PONG') return false
            const result = await this.publisher.call('COMMAND', 'INFO', 'XADD')
            return Array.isArray(result) && result.length > 0 && result[0] !== null
        } catch {
            return false
        }
    }

    async checkConnection(): Promise<boolean> {
        try {
            return await this.publisher.ping() === 'PONG'
        } catch {
            return false
        }
    }

    eventKey(reviewId: string): string {
        return `review:events:${reviewId}`
    }

    async onModuleDestroy(): Promise<void> {
        await this.publisher.quit()
    }
}
