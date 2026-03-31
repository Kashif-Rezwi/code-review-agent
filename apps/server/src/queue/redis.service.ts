import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Redis } from 'ioredis'

@Injectable()
export class RedisService implements OnModuleDestroy {
    public publisher: Redis
    private redisUrl: string

    constructor(config: ConfigService) {
        this.redisUrl = config.getOrThrow('REDIS_URL')
        this.publisher = new Redis(this.redisUrl)
    }

    /**
     * Create a fresh Redis connection.
     * Required for subscribers since an ioredis instance in subscribe mode Cannot issue other commands.
     */
    createSubscriber(): Redis {
        return new Redis(this.redisUrl)
    }

    /**
     * Appends an event to the replay list, sets TTL, and broadcasts it atomically 
     * via a Redis pipeline to eliminate network round-trip overhead.
     */
    async emitEvent(reviewId: string, message: string): Promise<void> {
        const key = `rl:${reviewId}`
        await this.publisher
            .pipeline()
            .rpush(key, message)
            .expire(key, 3600)
            .publish(`re:${reviewId}`, message)
            .exec()
    }

    /**
     * Retrieves all events from the replay list.
     */
    async getLog(reviewId: string): Promise<string[]> {
        return this.publisher.lrange(`rl:${reviewId}`, 0, -1)
    }

    onModuleDestroy() {
        this.publisher.quit()
    }
}
