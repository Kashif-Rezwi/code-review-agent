import { Module, Global } from '@nestjs/common'
import { AiService } from './ai.service'

@Global()
@Module({
    providers: [AiService],
    exports: [AiService],
})
export class AiModule {}
