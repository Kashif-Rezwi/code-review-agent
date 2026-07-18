import { PrismaService } from '../prisma/prisma.service'
import { HistoryRepository } from './history.repository'

describe('HistoryRepository PARTIAL queries', () => {
    it('includes PARTIAL reviews in history and returns a separate partial count', async () => {
        const review = {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn()
                .mockResolvedValueOnce(5)
                .mockResolvedValueOnce(2),
        }
        const issue = {
            groupBy: jest.fn()
                .mockResolvedValueOnce([{ type: 'bug', _count: { type: 3 } }])
                .mockResolvedValueOnce([{ severity: 'warning', _count: { severity: 3 } }]),
        }
        const repository = new HistoryRepository({ review, issue } as unknown as PrismaService)

        await repository.listReviews('user-1')
        const stats = await repository.getStats('user-1')

        expect(review.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { userId: 'user-1', status: { in: ['COMPLETE', 'PARTIAL'] } },
            select: expect.objectContaining({ status: true, coverage: true }),
        }))
        expect(review.count).toHaveBeenNthCalledWith(1, {
            where: { userId: 'user-1', status: { in: ['COMPLETE', 'PARTIAL'] } },
        })
        expect(review.count).toHaveBeenNthCalledWith(2, {
            where: { userId: 'user-1', status: 'PARTIAL' },
        })
        expect(stats).toEqual({
            totalReviews: 5,
            partialReviews: 2,
            issuesByType: [{ type: 'bug', count: 3 }],
            issuesBySeverity: [{ severity: 'warning', count: 3 }],
        })
        expect(issue.groupBy).toHaveBeenCalledWith(expect.objectContaining({
            where: { review: { userId: 'user-1', status: { in: ['COMPLETE', 'PARTIAL'] } } },
        }))
    })
})
