import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import type { Response } from 'express'
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

    async getReview(id: string, userId: string) {
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

    async chat(id: string, userId: string, message: string, res: Response) {
        // Validate before touching res — NotFoundException is handled by NestJS before headers are set
        const review = await this.getReview(id, userId)
        const system = this.buildChatSystem(review)

        const history = review.conversations.map((c) => ({
            role: c.role as 'user' | 'assistant',
            content: c.content,
        }))

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')
        res.flushHeaders()

        const result = streamText({
            model: this.openai('gpt-4o-mini'),
            system,
            messages: [...history, { role: 'user', content: message }],
            temperature: 0.3,
        })

        let fullText = ''
        try {
            for await (const chunk of result.textStream) {
                fullText += chunk
                res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`)
            }
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        } catch {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted' })}\n\n`)
        } finally {
            res.end()
        }

        // Persist after stream completes — client is already disconnected, log failures
        if (fullText) {
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

REVIEW SUMMARY: ${review.summary || '(Not completed yet)'}
SCORE: ${review.score !== null ? review.score : '-'}/10

ISSUES FOUND:
${issueList}

Answer the user's questions about this review. Be concise and specific. Do not re-state the full review unless asked.`
    }
}
