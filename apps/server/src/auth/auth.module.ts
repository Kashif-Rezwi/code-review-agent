import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'
import { TokenCacheService } from './token-cache.service'
import { UsersModule } from '../users/users.module'
import { GithubModule } from '../github/github.module'

@Module({
    imports: [ConfigModule, UsersModule, GithubModule],
    providers: [AuthGuard, AuthService, TokenCacheService],
    exports: [AuthGuard, AuthService, TokenCacheService, UsersModule],
})
export class AuthModule {}
