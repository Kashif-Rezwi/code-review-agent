import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { Review, Issue, Conversation } from '@prisma/client'

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
            where: { userId },
            select: {
                id: true,
                type: true,
                summary: true,
                score: true,
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

    async getStats(userId: string) {
        const [totalReviews, byType, bySeverity] = await Promise.all([
            this.prisma.review.count({ where: { userId } }),
            this.prisma.issue.groupBy({
                by: ['type'],
                where: { review: { userId } },
                _count: { type: true },
                orderBy: { _count: { type: 'desc' } },
            }),
            this.prisma.issue.groupBy({
                by: ['severity'],
                where: { review: { userId } },
                _count: { severity: true },
            }),
        ])

        return {
            totalReviews,
            issuesByType: byType.map((r) => ({ type: r.type, count: r._count.type })),
            issuesBySeverity: bySeverity.map((r) => ({
                severity: r.severity,
                count: r._count.severity,
            })),
        }
    }

    async deleteReview(id: string, userId: string): Promise<boolean> {
        const existing = await this.prisma.review.findFirst({ where: { id, userId } })
        if (!existing) return false
        await this.prisma.review.delete({ where: { id } })
        return true
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
