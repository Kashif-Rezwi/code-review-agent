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

/** Minimal LRU entry: the resolved user + expiry timestamp. */
interface CacheEntry {
    userId: string
    login: string
    name: string | null
    avatarUrl: string | null
    expiresAt: number
}

/**
 * AuthGuard — validates every incoming Bearer token by calling the GitHub /user API.
 * Results are cached in-memory for GITHUB_TOKEN_CACHE_TTL_MS (default 5 min) to
 * avoid hitting GitHub's rate limit on every SSE chunk.
 *
 * On success, attaches { userId, login, name, avatarUrl } to req.user.
 */
@Injectable()
export class AuthGuard implements CanActivate {
    private readonly logger = new Logger(AuthGuard.name)
    private readonly cache = new Map<string, CacheEntry>()
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

        if (!authHeader?.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing or malformed Authorization header.')
        }

        const token = authHeader.slice(7).trim()
        if (!token) {
            throw new UnauthorizedException('Bearer token is empty.')
        }

        // Check the in-memory cache before making a GitHub API call
        const cached = this.cache.get(token)
        if (cached && cached.expiresAt > Date.now()) {
            ;(req as any).user = {
                userId: cached.userId,
                login: cached.login,
                name: cached.name,
                avatarUrl: cached.avatarUrl,
            }
            return true
        }

        // Validate token and fetch profile from GitHub
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
            this.logger.error(`GitHub /user API call failed: ${err}`)
            throw new UnauthorizedException('Could not validate credentials with GitHub.')
        }

        // Upsert the User record in our database
        const user = await this.users.findOrCreate({
            id: String(profile.id),
            login: profile.login,
            name: profile.name,
            email: profile.email ?? null,
            avatarUrl: profile.avatar_url,
        })

        // Cache the result
        const entry: CacheEntry = {
            userId: user.id,
            login: user.login,
            name: user.name ?? null,
            avatarUrl: user.avatarUrl ?? null,
            expiresAt: Date.now() + this.ttl,
        }
        this.cache.set(token, entry)

        // Prune stale cache entries (simple GC — avoids unbounded growth)
        if (this.cache.size > 500) {
            const now = Date.now()
            for (const [k, v] of this.cache.entries()) {
                if (v.expiresAt <= now) this.cache.delete(k)
            }
        }

        ;(req as any).user = {
            userId: user.id,
            login: user.login,
            name: user.name ?? null,
            avatarUrl: user.avatarUrl ?? null,
        }

        return true
    }
}
