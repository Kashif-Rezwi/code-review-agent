import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AuthGuard } from './auth.guard'
import { AuthController } from './auth.controller'
import { UsersModule } from '../users/users.module'

@Module({
    imports: [ConfigModule, UsersModule],
    controllers: [AuthController],
    providers: [AuthGuard],
    exports: [AuthGuard],
})
export class AuthModule {}
