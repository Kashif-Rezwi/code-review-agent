import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards, Logger, Sse, MessageEvent } from '@nestjs/common'
import type { Request } from 'express'
import { Observable } from 'rxjs'
import { HistoryService } from './history.service'
import { ChatMessageDto } from './dto/chat-message.dto'
import { AuthGuard } from '../auth/auth.guard'
import { UserThrottlerGuard } from '../throttle/user-throttler.guard'
import { Throttle } from '@nestjs/throttler'

@UseGuards(AuthGuard)
@Controller('history')
export class HistoryController {
    private readonly logger = new Logger(HistoryController.name)

    constructor(private readonly historyService: HistoryService) { }

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
        return new Observable((subscriber) => {
            const stream = this.historyService.chatGenerator(id, req.user!.userId, dto.message)

            void (async () => {
                try {
                    for await (const chunk of stream) {
                        subscriber.next({ data: { type: 'delta', text: chunk } })
                    }
                    subscriber.next({ data: { type: 'done' } })
                } catch (err) {
                    this.logger.error(`Failed to stream chat answer: ${err instanceof Error ? err.message : err}`)
                    subscriber.next({ data: { type: 'error', message: 'Stream interrupted' } })
                } finally {
                    subscriber.complete()
                }
            })()
        })
    }
}
