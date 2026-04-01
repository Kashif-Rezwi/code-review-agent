import { Injectable, Logger, NotFoundException } from '@nestjs/common'

import { AiService } from '../ai/ai.service'
import { streamText } from 'ai'
import { HistoryRepository, ReviewWithRelations } from './history.repository'

@Injectable()
export class HistoryService {
    private readonly logger = new Logger(HistoryService.name)
    constructor(
        private readonly historyRepository: HistoryRepository,
        private readonly aiService: AiService,
    ) {}

    listReviews(userId: string) {
        return this.historyRepository.listReviews(userId)
    }

    async getReview(id: string, userId: string) {
        const review = await this.historyRepository.getReview(id, userId)
        if (!review) throw new NotFoundException(`Review ${id} not found.`)
        return review
    }

    async getStats(userId: string) {
        return this.historyRepository.getStats(userId)
    }

    /**
     * Streams the chat completion from the LLM, yielding text chunks.
     * Persists the conversation securely to the database when the stream naturally completes.
     */
    async *chatGenerator(id: string, userId: string, message: string): AsyncGenerator<string, void, unknown> {
        const review = await this.getReview(id, userId)
        const system = this.buildChatSystem(review)

        const history = review.conversations.map((c) => ({
            role: c.role as 'user' | 'assistant',
            content: c.content,
        }))

        const result = streamText({
            model: this.aiService.defaultModel,
            system,
            messages: [...history, { role: 'user', content: message }],
            temperature: 0.3,
        })

        let fullText = ''
        
        // Let any AI SDK errors throw naturally back to the controller
        for await (const chunk of result.textStream) {
            fullText += chunk
            yield chunk
        }

        if (fullText) {
            await this.historyRepository.saveChatQuery(id, message, fullText)
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
