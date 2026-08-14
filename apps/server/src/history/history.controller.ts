import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards, Logger, Sse, MessageEvent } from '@nestjs/common'
import type { Request } from 'express'
import { Observable } from 'rxjs'
import { HistoryService } from './history.service'
import { ChatMessageDto } from './dto/chat-message.dto'
import { ProviderStreamError } from '../ai/ai-runtime.adapter'
import { AuthGuard } from '../auth/auth.guard'
import { UserThrottlerGuard } from '../throttle/user-throttler.guard'
import { Throttle } from '@nestjs/throttler'

import { CreditGuard } from '../payments/credit.guard'
import { CreditCost } from '../payments/credit-cost.decorator'
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
    @UseGuards(UserThrottlerGuard, CreditGuard)
    @CreditCost(CREDIT_COSTS.CHAT)
    @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
    chat(@Param('id') id: string, @Body() dto: ChatMessageDto, @Req() req: Request): Observable<MessageEvent> {
        return new Observable((subscriber) => {
            // Teardown aborts the model call so a disconnected client stops spending tokens.
            const abort = new AbortController()
            const stream = this.historyService.chatGenerator(id, req.user!.userId, dto.message, abort.signal)

            void (async () => {
                try {
                    for await (const chunk of stream) {
                        subscriber.next({ data: { type: 'delta', text: chunk } })
                    }
                    subscriber.next({ data: { type: 'done' } })
                } catch (err) {
                    if (abort.signal.aborted) return
                    this.logger.error(`Failed to stream chat answer: ${err instanceof Error ? err.message : err}`)
                    // S-04: Refund pre-deducted credits if the chat stream failed after CreditGuard deduction.
                    const creditReq = req as Request & { creditDeducted?: number; creditUserId?: string }
                    if (creditReq.creditDeducted && creditReq.creditUserId) {
                        void this.paymentsService.refundCredits({
                            userId: creditReq.creditUserId,
                            cost: creditReq.creditDeducted,
                            reviewId: null,
                            description: 'Refund: chat stream failed',
                        }).catch((refundErr: unknown) => {
                            this.logger.error(
                                `Failed to refund chat credits: ${refundErr instanceof Error ? refundErr.message : String(refundErr)}`,
                            )
                        })
                    }
                    const message = err instanceof ProviderStreamError
                        ? 'The AI provider returned an error. Please try again later.'
                        : 'Stream interrupted'
                    subscriber.next({ data: { type: 'error', message } })
                } finally {
                    subscriber.complete()
                }
            })()

            return () => abort.abort()
        })
    }
}
