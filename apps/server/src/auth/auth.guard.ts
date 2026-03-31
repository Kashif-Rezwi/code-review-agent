import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Request } from 'express'
import { UsersService } from '../users/users.service'

interface GithubUserResponse {
    id: number
    login: string
    name: string | null
    email: string | null
    avatar_url: string
}

/** Shape of the authenticated user attached to req.user by AuthGuard. */
export interface AuthUser {
    userId: string
    login: string
    name: string | null
    avatarUrl: string | null
}

/** Resolved user + expiry timestamp for the in-memory LRU cache. */
interface CacheEntry extends AuthUser {
    expiresAt: number
}

/**
 * AuthGuard — validates every incoming Bearer token by calling the GitHub /user API.
 * Results are cached in-memory for GITHUB_TOKEN_CACHE_TTL_MS (default 5 min) to
 * avoid hitting GitHub's rate limit on every SSE chunk.
 *
 * In-flight deduplication ensures concurrent requests with the same new token
 * only trigger one GitHub API call.
 *
 * On success, attaches { userId, login, name, avatarUrl } to req.user.
 */
@Injectable()
export class AuthGuard implements CanActivate {
    private readonly logger = new Logger(AuthGuard.name)
    private readonly cache = new Map<string, CacheEntry>()
    private readonly inFlight = new Map<string, Promise<CacheEntry>>()
    private readonly ttl: number

    constructor(
        private readonly users: UsersService,
        private readonly config: ConfigService,
    ) {
        this.ttl = this.config.get<number>('GITHUB_TOKEN_CACHE_TTL_MS') ?? 300_000
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>()
        const authHeader = req.headers['authorization']
        let token: string | undefined

        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim()
        } else if (req.query.token && typeof req.query.token === 'string') {
            token = req.query.token
        }

        if (!token) {
            throw new UnauthorizedException('Missing or malformed Authorization token.')
        }

        const entry = await this.resolve(token)

        req.user = {
            userId: entry.userId,
            login: entry.login,
            name: entry.name,
            avatarUrl: entry.avatarUrl,
        }

        return true
    }

    /**
     * Returns a cached entry if valid, otherwise resolves via GitHub API.
     * Uses an in-flight map to deduplicate concurrent calls for the same token.
     */
    private async resolve(token: string): Promise<CacheEntry> {
        // Cache hit
        const cached = this.cache.get(token)
        if (cached && cached.expiresAt > Date.now()) {
            return cached
        }

        // In-flight dedup: if another request is already resolving this token, reuse its promise
        const existing = this.inFlight.get(token)
        if (existing) return existing

        const promise = this.fetchAndUpsert(token)
        this.inFlight.set(token, promise)

        try {
            const entry = await promise
            // Prune stale entries before writing (cache never exceeds threshold)
            if (this.cache.size >= 500) {
                const now = Date.now()
                for (const [k, v] of this.cache.entries()) {
                    if (v.expiresAt <= now) this.cache.delete(k)
                }
            }
            this.cache.set(token, entry)
            return entry
        } finally {
            this.inFlight.delete(token)
        }
    }

    /** Validates token against GitHub /user API and upserts the user record. */
    private async fetchAndUpsert(token: string): Promise<CacheEntry> {
        let profile: GithubUserResponse
        try {
            const res = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            })

            if (!res.ok) {
                if (res.status === 401) {
                    throw new UnauthorizedException('GitHub token is invalid or expired.')
                }
                throw new UnauthorizedException(`GitHub API returned ${res.status}.`)
            }

            profile = (await res.json()) as GithubUserResponse
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

        return {
            userId: user.id,
            login: user.login,
            name: user.name ?? null,
            avatarUrl: user.avatarUrl ?? null,
            expiresAt: Date.now() + this.ttl,
        }
    }
}
