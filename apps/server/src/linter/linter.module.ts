import { Module } from '@nestjs/common'
import { LinterService } from './linter.service'

@Module({
    providers: [LinterService],
    exports: [LinterService],
})
export class LinterModule { }
