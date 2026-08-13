import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import type { ReviewStatus } from '@prisma/client'

import { AiService } from '../ai/ai.service'
import { ProviderStreamError, runChatStream, toProviderStreamError } from '../ai/ai-runtime.adapter'
import { AI_POLICY } from '../ai/ai-policy'
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

    /** Status-only poll used by the SSE streamer loop; null means the review no longer exists. */
    async getReviewStatus(id: string, userId: string): Promise<ReviewStatus | null> {
        return this.historyRepository.getReviewStatus(id, userId)
    }

    async getStats(userId: string) {
        return this.historyRepository.getStats(userId)
    }

    async deleteReview(id: string, userId: string): Promise<void> {
        const deleted = await this.historyRepository.deleteReview(id, userId)
        if (!deleted) throw new NotFoundException(`Review ${id} not found.`)
    }

    /**
     * Streams the chat completion from the LLM, yielding text chunks.
     * Persists the conversation securely to the database when the stream naturally completes.
     *
     * Same provider-error contract as the review pipeline: the AI SDK resolves a
     * failed stream with empty text instead of throwing, so a captured stream
     * error is rethrown after the loop — never saved as a blank answer.
     */
    async *chatGenerator(id: string, userId: string, message: string, signal?: AbortSignal): AsyncGenerator<string, void, unknown> {
        const review = await this.getReview(id, userId)
        const system = this.buildChatSystem(review)

        const history = review.conversations.map((c) => ({
            role: c.role as 'user' | 'assistant',
            content: c.content,
        }))

        let providerError: ProviderStreamError | undefined
        const result = runChatStream({
            model: this.aiService.fastModel,
            system,
            messages: [...history, { role: 'user', content: message }],
            temperature: AI_POLICY.temperature.chat,
            maxOutputTokens: AI_POLICY.maxOutputTokens.chat,
            abortSignal: signal,
            onError: ({ error }: { error: unknown }) => {
                providerError = toProviderStreamError(error)
            },
        })

        let fullText = ''
        for await (const chunk of result.textStream) {
            fullText += chunk
            yield chunk
        }

        if (providerError) throw providerError
        // A disconnected client aborts mid-stream — don't persist a partial answer.
        if (signal?.aborted) return

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
