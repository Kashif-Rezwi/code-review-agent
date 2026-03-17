import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { HistoryService } from './history.service'
import { ChatMessageDto } from './dto/chat-message.dto'

@Controller('history')
export class HistoryController {
    constructor(private readonly historyService: HistoryService) { }

    // GET /history
    @Get()
    listReviews() {
        return this.historyService.listReviews()
    }

    // GET /history/stats — Must be declared before :id — NestJS matches literal segments first
    @Get('stats')
    getStats() {
        return this.historyService.getStats()
    }

    // GET /history/:id
    @Get(':id')
    getReview(@Param('id') id: string) {
        return this.historyService.getReview(id)
    }

    // POST /history/:id/chat  — streams SSE token-by-token
    @Post(':id/chat')
    async chat(@Param('id') id: string, @Body() dto: ChatMessageDto, @Res() res: Response) {
        await this.historyService.chat(id, 'default', dto.message, res)
    }
}
