import type { Redis } from 'ioredis'

import { createRedisEmitter } from './review.emitter'
import { RedisService } from './redis.service'

describe('Redis Streams review delivery', () => {
    it('decodes ordered XREAD entries after the supplied Stream ID', async () => {
        const xread = jest.fn().mockResolvedValue([
                ['review:events:review-1', [
                    ['100-1', ['event', '{"type":"start"}']],
                    ['100-2', ['event', '{"type":"thinking","text":"checking"}']],
                ]],
            ])
        const connection = { xread } as unknown as Redis
        const service = Object.create(RedisService.prototype) as RedisService

        await expect(service.readEvents(connection, 'review-1', '99-7', 15_000, 100)).resolves.toEqual([
            { id: '100-1', message: '{"type":"start"}' },
            { id: '100-2', message: '{"type":"thinking","text":"checking"}' },
        ])
        expect(xread).toHaveBeenCalledWith(
            'COUNT', 100, 'BLOCK', 15_000, 'STREAMS', 'review:events:review-1', '99-7',
        )
    })

    it('serializes appends and flushes the terminal event before completion', async () => {
        const appended: string[] = []
        const redis = {
            emitEvent: jest.fn(async (_reviewId: string, message: string) => {
                await Promise.resolve()
                appended.push(message)
                return `${appended.length}-0`
            }),
        } as unknown as RedisService
        const emitter = createRedisEmitter(redis, 'review-1')

        emitter.send({ type: 'start' })
        emitter.send({ type: 'error', message: 'terminal' })
        await emitter.flush()

        expect(appended.map((message) => JSON.parse(message))).toEqual([
            { type: 'start' },
            { type: 'error', message: 'terminal' },
        ])
    })
})
