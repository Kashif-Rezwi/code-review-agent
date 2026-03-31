import { Module } from '@nestjs/common'
import { BullModule } from '@nestjs/bullmq'
import { ConfigService } from '@nestjs/config'
import { QueueService } from './queue.service'
import { RedisService } from './redis.service'

@Module({
    imports: [
        BullModule.forRootAsync({
            useFactory: (config: ConfigService) => ({
                connection: { url: config.getOrThrow('REDIS_URL') },
            }),
            inject: [ConfigService],
        }),
        BullModule.registerQueue({ name: 'review-jobs' }),
    ],
    providers: [QueueService, RedisService],
    exports: [QueueService, RedisService, BullModule],
})
export class QueueModule {}
