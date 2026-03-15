import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { PrismaService } from '../prisma/prisma.service'

type ReviewWithRelations = Awaited<ReturnType<HistoryService['getReview']>>

@Injectable()
export class HistoryService {
    private readonly logger = new Logger(HistoryService.name)
    private readonly openai: ReturnType<typeof createOpenAI>

    constructor(
        private readonly prisma: PrismaService,
        config: ConfigService,
    ) {
        this.openai = createOpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') })
    }

    listReviews(userId = 'default') {
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

    async getReview(id: string, userId = 'default') {
        const review = await this.prisma.review.findFirst({
            where: { id, userId },
            include: {
                issues: true,
                conversations: { orderBy: { createdAt: 'asc' } },
            },
        })
        if (!review) throw new NotFoundException(`Review ${id} not found.`)
        return review
    }

    async getStats(userId = 'default') {
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

    async chat(id: string, userId = 'default', message: string) {
        const review = await this.getReview(id, userId)
        const system = this.buildChatSystem(review)

        const history = review.conversations.map((c) => ({
            role: c.role as 'user' | 'assistant',
            content: c.content,
        }))

        const { text } = await generateText({
            model: this.openai('gpt-4o-mini'),
            system,
            messages: [...history, { role: 'user', content: message }],
            temperature: 0.3,
        })

        await this.prisma.$transaction([
            this.prisma.conversation.create({
                data: { reviewId: id, role: 'user', content: message },
            }),
            this.prisma.conversation.create({
                data: { reviewId: id, role: 'assistant', content: text },
            }),
        ])

        return { role: 'assistant' as const, content: text }
    }

    private buildChatSystem(review: ReviewWithRelations): string {
        const issueList =
            review.issues
                .map(
                    (i) =>
                        `- [${i.severity}] ${i.title} at ${i.location}: ${i.description}`,
                )
                .join('\n') || 'No issues found.'

        return `You are a helpful code review assistant. The user is asking follow-up questions about a code review.

ORIGINAL ${review.type === 'PR' ? 'PR URL' : 'CODE'}:
${review.input.slice(0, 2000)}${review.input.length > 2000 ? '\n[truncated]' : ''}

REVIEW SUMMARY: ${review.summary}
SCORE: ${review.score}/10

ISSUES FOUND:
${issueList}

Answer the user's questions about this review. Be concise and specific. Do not re-state the full review unless asked.`
    }
}
