import { Module } from '@nestjs/common'
import { RagController } from './rag.controller'
import { RagService } from './rag.service'
import { AuthModule } from '../auth/auth.module'

// PrismaModule is @Global() so no need to import it here.
@Module({
    imports: [AuthModule],
    controllers: [RagController],
    providers: [RagService],
    exports: [RagService], // ReviewModule imports this to call retrieveForContext()
})
export class RagModule {}
