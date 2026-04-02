import { Module } from '@nestjs/common'
import { HistoryController } from './history.controller'
import { HistoryService } from './history.service'
import { HistoryRepository } from './history.repository'
import { AuthModule } from '../auth/auth.module'

@Module({
    imports: [AuthModule],
    controllers: [HistoryController],
    providers: [HistoryService, HistoryRepository],
    exports: [HistoryService],
})
export class HistoryModule { }
