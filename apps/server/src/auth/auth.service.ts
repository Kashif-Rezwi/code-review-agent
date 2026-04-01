import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { UsersService } from '../users/users.service'
import { TokenCacheService, CacheEntry } from './token-cache.service'

import { GithubService, GithubUserResponse } from '../github/github.service'

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name)

    constructor(
        private readonly users: UsersService,
        private readonly tokenCache: TokenCacheService,
        private readonly githubService: GithubService,
    ) {}

    /**
     * Returns a cached entry if valid, otherwise resolves via GitHub API.
     * Uses an in-flight map to deduplicate concurrent calls for the same token.
     */
    async resolve(token: string): Promise<CacheEntry> {
        // Cache hit
        const cached = this.tokenCache.getCached(token)
        if (cached) {
            return cached
        }

        // In-flight dedup: if another request is already resolving this token, reuse its promise
        const existing = this.tokenCache.getInFlight(token)
        if (existing) return existing

        const promise = this.fetchAndUpsert(token)
        this.tokenCache.setInFlight(token, promise)

        try {
            const entry = await promise
            return this.tokenCache.cacheEntry(token, entry)
        } finally {
            this.tokenCache.removeInFlight(token)
        }
    }

    /** Validates token against GitHub /user API and upserts the user record. */
    private async fetchAndUpsert(token: string): Promise<CacheEntry> {
        let profile: GithubUserResponse
        try {
            profile = await this.githubService.fetchUserProfile(token)
        } catch (err) {
            if (err instanceof UnauthorizedException) throw err
            this.logger.error(`GitHub /user API call failed: ${(err as Error).message}`)
            throw new UnauthorizedException('Could not validate credentials with GitHub.')
        }

        const user = await this.users.findOrCreate({
            id: String(profile.id),
            login: profile.login,
            name: profile.name,
            email: profile.email ?? null,
            avatarUrl: profile.avatar_url,
        })

        // expiresAt is set by `TokenCacheService.cacheEntry` in `resolve` wrapper
        return {
            userId: user.id,
            login: user.login,
            name: user.name ?? null,
            avatarUrl: user.avatarUrl ?? null,
            expiresAt: 0, 
        }
    }
}
