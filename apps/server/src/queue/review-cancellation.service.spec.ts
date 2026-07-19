import type { Redis } from 'ioredis'
import { ReviewCancellationService, ReviewCancelledError, OperationDeadlineError, operationDeadline } from './review-cancellation.service'
import type { RedisService } from './redis.service'

describe('distributed review cancellation and deadlines', () => {
    it('checks the cancellation key again after subscribing to close the race', async () => {
        const listeners = new Map<string, (channel: string) => void>()
        const quit = jest.fn().mockResolvedValue('OK')
        const subscriber = {
            on: jest.fn((name: string, callback: (channel: string) => void) => listeners.set(name, callback)),
            subscribe: jest.fn().mockResolvedValue(1),
            quit,
        } as unknown as Redis
        const publisher = { exists: jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1) }
        const redis = {
            publisher,
            createConnection: jest.fn().mockReturnValue(subscriber),
        } as unknown as RedisService

        const execution = await new ReviewCancellationService(redis).createExecution('review-1', 300_000)

        expect(execution.signal.aborted).toBe(true)
        expect(execution.signal.reason).toBeInstanceOf(ReviewCancelledError)
        await execution.dispose()
        expect(quit).toHaveBeenCalled()
    })

    it('aborts an operation at its own deadline', () => {
        jest.useFakeTimers()
        const deadline = operationDeadline(undefined, 'Planner', 30_000)
        jest.advanceTimersByTime(30_000)
        expect(deadline.signal.reason).toBeInstanceOf(OperationDeadlineError)
        deadline.dispose()
        jest.useRealTimers()
    })
})
