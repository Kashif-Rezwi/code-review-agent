import { Module } from '@nestjs/common'
import { HistoryController } from './history.controller'
import { HistoryService } from './history.service'
import { AuthModule } from '../auth/auth.module'

@Module({
    imports: [AuthModule],
    controllers: [HistoryController],
    providers: [HistoryService],
    exports: [HistoryService], // Added so ReviewController can fetch review instances
})
export class HistoryModule {}
