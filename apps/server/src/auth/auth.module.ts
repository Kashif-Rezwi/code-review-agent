import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AuthGuard } from './auth.guard'
import { UsersModule } from '../users/users.module'

@Module({
    imports: [ConfigModule, UsersModule],
    providers: [AuthGuard],
    exports: [AuthGuard, UsersModule],
})
export class AuthModule {}
