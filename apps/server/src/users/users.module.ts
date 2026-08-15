import { Module } from '@nestjs/common'
import { UsersService } from './users.service'
import { PrismaModule } from '../prisma/prisma.module'
import { PaymentsModule } from '../payments/payments.module'

@Module({
    imports: [PrismaModule, PaymentsModule],
    providers: [UsersService],
    exports: [UsersService],
})
export class UsersModule {}
