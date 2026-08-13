import type { MessageEvent } from '@nestjs/common'
import type { ReviewWithRelations } from '../history/history.repository'
import type { HistoryService } from '../history/history.service'
import type { RedisService } from '../queue/redis.service'
import { ReviewStreamerService } from './review-streamer.service'

function completedReview(): ReviewWithRelations {
    return {
        id: 'review-1',
        userId: 'user-1',
        type: 'PR',
        input: 'https://github.com/acme/repo/pull/1',
        status: 'COMPLETE',
        summary: 'Safe change',
        score: 9,
        positives: ['Focused implementation'],
        appliedStandards: [],
        coverage: null,
        traceLog: [{ type: 'start' }],
        createdAt: new Date(),
        updatedAt: new Date(),
        issues: [{
            id: 'issue-1',
            reviewId: 'review-1',
            type: 'BUG',
            severity: 'WARNING',
            title: 'Guard the branch',
            location: 'src/a.ts:1',
            description: 'The branch needs a guard.',
            recommendation: 'Add a guard.',
            createdAt: new Date(),
        }],
        conversations: [],
    } as unknown as ReviewWithRelations
}

describe('ReviewStreamerService terminal recovery', () => {
    it('replays intermediate history and reconstructs a full terminal review from PostgreSQL', async () => {
        const reader = { quit: jest.fn().mockResolvedValue('OK') }
        const redis = {
            createConnection: jest.fn().mockReturnValue(reader),
            readEvents: jest.fn().mockResolvedValue([
                { id: '10-1', message: JSON.stringify({ type: 'start' }) },
            ]),
        } as unknown as RedisService
        const history = {
            getReview: jest.fn().mockResolvedValue(completedReview()),
            getReviewStatus: jest.fn().mockResolvedValue('COMPLETE'),
        } as unknown as HistoryService
        const service = new ReviewStreamerService(redis, history)

        const events = await collect(service.createStream('review-1', 'user-1'))

        expect(events[0]).toMatchObject({ id: '10-1', data: { type: 'start' } })
        expect(events.at(-1)).toMatchObject({
            data: {
                type: 'complete',
                review: {
                    id: 'review-1',
                    summary: 'Safe change',
                    score: 9,
                    positives: ['Focused implementation'],
                    issues: [expect.objectContaining({ title: 'Guard the branch' })],
                },
            },
        })
        expect(reader.quit).toHaveBeenCalled()
    })

    it('recovers the terminal review even when Redis is unavailable', async () => {
        const reader = { quit: jest.fn().mockResolvedValue('OK') }
        const redis = {
            createConnection: jest.fn().mockReturnValue(reader),
            readEvents: jest.fn().mockRejectedValue(new Error('redis unavailable')),
        } as unknown as RedisService
        const history = {
            getReview: jest.fn().mockResolvedValue(completedReview()),
            getReviewStatus: jest.fn().mockResolvedValue('COMPLETE'),
        } as unknown as HistoryService

        const events = await collect(new ReviewStreamerService(redis, history).createStream('review-1', 'user-1'))
        expect(events).toHaveLength(1)
        expect(events[0].data).toMatchObject({ type: 'complete', review: { id: 'review-1' } })
    })

    it('recovers duration and step count from the persisted trace terminal event', async () => {
        const review = completedReview()
        review.traceLog = [
            { type: 'start' },
            { type: 'complete', review: { id: 'review-1' }, durationMs: 12_345, stepCount: 4, outcome: 'complete' },
        ]
        const reader = { quit: jest.fn().mockResolvedValue('OK') }
        const redis = {
            createConnection: jest.fn().mockReturnValue(reader),
            readEvents: jest.fn().mockResolvedValue([]),
        } as unknown as RedisService
        const history = {
            getReview: jest.fn().mockResolvedValue(review),
            getReviewStatus: jest.fn().mockResolvedValue('COMPLETE'),
        } as unknown as HistoryService

        const events = await collect(new ReviewStreamerService(redis, history).createStream('review-1', 'user-1'))

        expect(events.at(-1)?.data).toMatchObject({ type: 'complete', durationMs: 12_345, stepCount: 4 })
    })

    it('polls with the status-only query and loads the full row only for terminal reconstruction', async () => {
        const reader = { quit: jest.fn().mockResolvedValue('OK') }
        const redis = {
            createConnection: jest.fn().mockReturnValue(reader),
            readEvents: jest.fn().mockResolvedValue([]),
        } as unknown as RedisService
        const getReview = jest.fn()
            .mockResolvedValueOnce({ ...completedReview(), status: 'PENDING' })
            .mockResolvedValue(completedReview())
        const getReviewStatus = jest.fn()
            .mockResolvedValueOnce('PENDING')
            .mockResolvedValue('COMPLETE')
        const history = { getReview, getReviewStatus } as unknown as HistoryService

        const events = await collect(new ReviewStreamerService(redis, history).createStream('review-1', 'user-1'))

        expect(getReviewStatus).toHaveBeenCalledWith('review-1', 'user-1')
        // Initial full load + one full load for the terminal reconstruction — never per poll.
        expect(getReview).toHaveBeenCalledTimes(2)
        expect(events[0].data).toEqual({ type: 'heartbeat' })
        expect(events.at(-1)?.data).toMatchObject({ type: 'complete', review: { id: 'review-1' } })
    })
})

function collect(observable: ReturnType<ReviewStreamerService['createStream']>): Promise<MessageEvent[]> {
    return new Promise((resolve, reject) => {
        const events: MessageEvent[] = []
        observable.subscribe({ next: (event) => events.push(event), error: reject, complete: () => resolve(events) })
    })
}
