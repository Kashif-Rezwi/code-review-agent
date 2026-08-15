import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards, Logger, Sse, MessageEvent } from '@nestjs/common'
import type { Request } from 'express'
import { Observable } from 'rxjs'
import { HistoryService } from './history.service'
import { ChatMessageDto } from './dto/chat-message.dto'
import { ProviderStreamError } from '../ai/ai-runtime.adapter'
import { AuthGuard } from '../auth/auth.guard'
import { UserThrottlerGuard } from '../throttle/user-throttler.guard'
import { Throttle } from '@nestjs/throttler'
import { CREDIT_COSTS } from '../payments/credit-cost.policy'
import { PaymentsService } from '../payments/payments.service'

@UseGuards(AuthGuard)
@Controller('history')
export class HistoryController {
    private readonly logger = new Logger(HistoryController.name)

    constructor(
        private readonly historyService: HistoryService,
        private readonly paymentsService: PaymentsService,
    ) { }

    @Get()
    listReviews(@Req() req: Request) {
        return this.historyService.listReviews(req.user!.userId)
    }

    @Get('stats')
    getStats(@Req() req: Request) {
        return this.historyService.getStats(req.user!.userId)
    }

    @Get(':id')
    getReview(@Param('id') id: string, @Req() req: Request) {
        return this.historyService.getReview(id, req.user!.userId)
    }

    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteReview(@Param('id') id: string, @Req() req: Request) {
        await this.historyService.deleteReview(id, req.user!.userId)
    }

    // Paid endpoint (LLM calls) — 60 chat messages per user per hour.
    // Guard runs after the controller-level AuthGuard, so it keys on req.user.userId.
    @Post(':id/chat')
    @Sse()
    @UseGuards(UserThrottlerGuard)
    @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
    chat(@Param('id') id: string, @Body() dto: ChatMessageDto, @Req() req: Request): Observable<MessageEvent> {
        const userId = req.user!.userId

        return new Observable((subscriber) => {
            const abort = new AbortController()

            void (async () => {
                let creditDeducted = false
                let emittedChunkCount = 0

                try {
                    // PRD-003: Verify review existence and ownership BEFORE deducting credits
                    await this.historyService.getReview(id, userId)

                    // Atomically deduct 1 credit linked to this reviewId before starting the stream
                    const balanceAfter = await this.paymentsService.deductCredits({
                        userId,
                        cost: CREDIT_COSTS.CHAT,
                        reviewId: id,
                        description: 'Follow-up chat query',
                    })

                    if (balanceAfter === null) {
                        subscriber.next({
                            data: {
                                type: 'error',
                                message: 'Insufficient credits. Please top up your balance.',
                            },
                        })
                        subscriber.complete()
                        return
                    }

                    creditDeducted = true
                    const stream = this.historyService.chatGenerator(id, userId, dto.message, abort.signal)

                    for await (const chunk of stream) {
                        emittedChunkCount++
                        subscriber.next({ data: { type: 'delta', text: chunk } })
                    }
                    subscriber.next({ data: { type: 'done' } })
                } catch (err) {
                    if (abort.signal.aborted) return
                    this.logger.error(`Failed to stream chat answer: ${err instanceof Error ? err.message : err}`)

                    // RZC-011: Refund if the stream failed before yielding complete response or on early provider error
                    if (creditDeducted && emittedChunkCount === 0) {
                        await this.paymentsService.refundCredits({
                            userId,
                            cost: CREDIT_COSTS.CHAT,
                            reviewId: id,
                            description: 'Refund: chat stream failed',
                        }).catch((refundErr: unknown) => {
                            this.logger.error(
                                `Failed to refund chat credits: ${refundErr instanceof Error ? refundErr.message : String(refundErr)}`,
                            )
                        })
                    }

                    const message = err instanceof ProviderStreamError
                        ? 'The AI provider returned an error. Please try again later.'
                        : (err instanceof Error ? err.message : 'Stream interrupted')
                    subscriber.next({ data: { type: 'error', message } })
                } finally {
                    subscriber.complete()
                }
            })()

            return () => abort.abort()
        })
    }
}
