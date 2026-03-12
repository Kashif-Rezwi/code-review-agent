import { Module } from '@nestjs/common'
import { RagController } from './rag.controller'
import { RagService } from './rag.service'

// PrismaModule is @Global() so no need to import it here.
@Module({
    controllers: [RagController],
    providers: [RagService],
    exports: [RagService], // ReviewModule imports this to call retrieveForContext()
})
export class RagModule {}
