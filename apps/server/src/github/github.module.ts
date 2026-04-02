import { Module } from '@nestjs/common'
import { GithubService } from './github.service'
import { GithubCacheService } from './github-cache.service'

@Module({
    providers: [GithubService, GithubCacheService],
    exports: [GithubService],
})
export class GithubModule { }
