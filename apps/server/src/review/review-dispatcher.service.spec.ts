import type { PrismaService } from '../prisma/prisma.service'
import type { QueueService } from '../queue/queue.service'
import type { RedisService } from '../queue/redis.service'
import { ReviewDispatcherService } from './review-dispatcher.service'

const candidate = {
    id: 'dispatch-1',
    reviewId: 'review-1',
    status: 'PENDING',
    attempts: 0,
    availableAt: new Date('2026-07-18T12:00:00Z'),
    lockedUntil: null,
    lastError: null,
    dispatchedAt: null,
    createdAt: new Date('2026-07-18T12:00:00Z'),
    updatedAt: new Date('2026-07-18T12:00:00Z'),
} as const

const review = {
    id: 'review-1',
    userId: 'user-1',
    type: 'PR',
    input: 'https://github.com/acme/repo/pull/1',
    status: 'PENDING',
}

describe('ReviewDispatcherService', () => {
    it('lets multiple dispatchers claim the same outbox row only once', async () => {
        const updateMany = jest.fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 })
            .mockResolvedValue({ count: 1 })
        const prisma = {
            reviewDispatch: {
                findMany: jest.fn().mockResolvedValue([candidate]),
                updateMany,
            },
            review: { findUnique: jest.fn().mockResolvedValue(review) },
        } as unknown as PrismaService
        const enqueue = jest.fn().mockResolvedValue(undefined)
        const queue = { enqueue } as unknown as QueueService
        const redis = {} as RedisService
        const first = new ReviewDispatcherService(prisma, queue, redis)
        const second = new ReviewDispatcherService(prisma, queue, redis)

        await Promise.all([first.kick(), second.kick()])

        expect(enqueue).toHaveBeenCalledTimes(1)
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'review-1' }))
    })

    it('uses exact exponential availability after a dispatch failure', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00Z'))
        const updateMany = jest.fn().mockResolvedValue({ count: 1 })
        const findUnique = jest.fn()
            .mockResolvedValueOnce(review)
            .mockResolvedValueOnce({ status: 'PENDING' })
        const prisma = {
            reviewDispatch: { findMany: jest.fn().mockResolvedValue([candidate]), updateMany },
            review: { findUnique },
        } as unknown as PrismaService
        const queue = { enqueue: jest.fn().mockRejectedValue(new Error('BullMQ unavailable')) } as unknown as QueueService
        const service = new ReviewDispatcherService(prisma, queue, {} as RedisService)

        await service.kick()

        expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'PENDING',
                availableAt: new Date('2026-07-18T12:00:01Z'),
            }),
        }))
        jest.useRealTimers()
    })
})
