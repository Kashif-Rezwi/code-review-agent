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
     * Appends an event to the replay list and refreshes the TTL to 1 hour.
     */
    async addToLog(reviewId: string, message: string): Promise<void> {
        const key = `rl:${reviewId}`
        await this.publisher.rpush(key, message)
        await this.publisher.expire(key, 3600)
    }

    /**
     * Retrieves all events from the replay list.
     */
    async getLog(reviewId: string): Promise<string[]> {
        return this.publisher.lrange(`rl:${reviewId}`, 0, -1)
    }

    /**
     * Broadcasts an event to all live subscribers.
     */
    async broadcast(reviewId: string, message: string): Promise<void> {
        await this.publisher.publish(`re:${reviewId}`, message)
    }

    onModuleDestroy() {
        this.publisher.quit()
    }
}
