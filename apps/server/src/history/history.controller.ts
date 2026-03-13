import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import { HistoryService } from './history.service'
import { ChatMessageDto } from './dto/chat-message.dto'

@Controller('history')
export class HistoryController {
    constructor(private readonly historyService: HistoryService) {}

    // GET /history
    @Get()
    listReviews() {
        return this.historyService.listReviews()
    }

    // GET /history/stats — MUST be declared before :id to avoid NestJS treating "stats" as an id
    @Get('stats')
    getStats() {
        return this.historyService.getStats()
    }

    // GET /history/:id
    @Get(':id')
    getReview(@Param('id') id: string) {
        return this.historyService.getReview(id)
    }

    // POST /history/:id/chat
    @Post(':id/chat')
    @HttpCode(HttpStatus.OK)
    chat(@Param('id') id: string, @Body() dto: ChatMessageDto) {
        return this.historyService.chat(id, 'default', dto.message)
    }
}
