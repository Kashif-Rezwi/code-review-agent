import { Body, Controller, Get, Param, Post, Res, Req, UseGuards } from '@nestjs/common'
import type { Response, Request } from 'express'
import { HistoryService } from './history.service'
import { ChatMessageDto } from './dto/chat-message.dto'
import { AuthGuard } from '../auth/auth.guard'

@UseGuards(AuthGuard)
@Controller('history')
export class HistoryController {
    constructor(private readonly historyService: HistoryService) { }

    // GET /history
    @Get()
    listReviews(@Req() req: Request) {
        return this.historyService.listReviews((req as any).user.userId)
    }

    // GET /history/stats — Must be declared before :id — NestJS matches literal segments first
    @Get('stats')
    getStats(@Req() req: Request) {
        return this.historyService.getStats((req as any).user.userId)
    }

    // GET /history/:id
    @Get(':id')
    getReview(@Param('id') id: string, @Req() req: Request) {
        return this.historyService.getReview(id, (req as any).user.userId)
    }

    // POST /history/:id/chat  — streams SSE token-by-token
    @Post(':id/chat')
    async chat(@Param('id') id: string, @Body() dto: ChatMessageDto, @Res() res: Response, @Req() req: Request) {
        await this.historyService.chat(id, (req as any).user.userId, dto.message, res)
    }
}
