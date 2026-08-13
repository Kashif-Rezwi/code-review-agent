import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { ReviewStatus, type Review, type Issue, type Conversation } from '@prisma/client'

export type ReviewWithRelations = Review & {
    issues: Issue[]
    conversations: Conversation[]
}

@Injectable()
export class HistoryRepository {
    private readonly logger = new Logger(HistoryRepository.name)

    constructor(private readonly prisma: PrismaService) {}

    listReviews(userId: string) {
        return this.prisma.review.findMany({
            where: { userId, status: { in: ['COMPLETE', 'PARTIAL'] } },
            select: {
                id: true,
                type: true,
                status: true,
                summary: true,
                score: true,
                coverage: true,
                createdAt: true,
                _count: { select: { issues: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    }

    async getReview(id: string, userId: string): Promise<ReviewWithRelations | null> {
        return this.prisma.review.findFirst({
            where: { id, userId },
            include: {
                issues: true,
                conversations: { orderBy: { createdAt: 'asc' } },
            },
        })
    }

    /** Lightweight status probe for the SSE poll loop — avoids loading issues/conversations every cycle. */
    async getReviewStatus(id: string, userId: string): Promise<ReviewStatus | null> {
        const review = await this.prisma.review.findFirst({
            where: { id, userId },
            select: { status: true },
        })
        return review?.status ?? null
    }

    async getStats(userId: string) {
        const terminalStatuses: ReviewStatus[] = ['COMPLETE', 'PARTIAL']
        const [totalReviews, partialReviews, byType, bySeverity] = await Promise.all([
            this.prisma.review.count({ where: { userId, status: { in: terminalStatuses } } }),
            this.prisma.review.count({ where: { userId, status: 'PARTIAL' } }),
            this.prisma.issue.groupBy({
                by: ['type'],
                where: { review: { userId, status: { in: terminalStatuses } } },
                _count: { type: true },
                orderBy: { _count: { type: 'desc' } },
            }),
            this.prisma.issue.groupBy({
                by: ['severity'],
                where: { review: { userId, status: { in: terminalStatuses } } },
                _count: { severity: true },
            }),
        ])

        return {
            totalReviews,
            partialReviews,
            issuesByType: byType.map((r) => ({ type: r.type, count: r._count.type })),
            issuesBySeverity: bySeverity.map((r) => ({
                severity: r.severity,
                count: r._count.severity,
            })),
        }
    }

    async deleteReview(id: string, userId: string): Promise<boolean> {
        const { count } = await this.prisma.review.deleteMany({ where: { id, userId } })
        return count > 0
    }

    async saveChatQuery(id: string, message: string, fullText: string): Promise<void> {
        try {
            await this.prisma.$transaction([
                this.prisma.conversation.create({
                    data: { reviewId: id, role: 'user', content: message },
                }),
                this.prisma.conversation.create({
                    data: { reviewId: id, role: 'assistant', content: fullText },
                }),
            ])
        } catch (err) {
            this.logger.error(`Failed to persist chat for review ${id}`, err)
        }
    }
}
