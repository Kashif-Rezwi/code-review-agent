import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

// @Global so every module can inject PrismaService without re-importing PrismaModule.
@Global()
@Module({
    providers: [PrismaService],
    exports: [PrismaService],
})
export class PrismaModule {}
