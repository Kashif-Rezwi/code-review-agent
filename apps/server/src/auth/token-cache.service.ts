import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { AuthUser } from './auth.guard'

export interface CacheEntry extends AuthUser {
    expiresAt: number
}

@Injectable()
export class TokenCacheService {
    private readonly cache = new Map<string, CacheEntry>()
    private readonly inFlight = new Map<string, Promise<CacheEntry>>()
    private readonly ttl: number

    constructor(private readonly config: ConfigService) {
        this.ttl = this.config.get<number>('GITHUB_TOKEN_CACHE_TTL_MS') ?? 300_000
    }

    getCached(token: string): CacheEntry | undefined {
        const cached = this.cache.get(token)
        if (cached && cached.expiresAt > Date.now()) {
            return cached
        }
        return undefined
    }

    getInFlight(token: string): Promise<CacheEntry> | undefined {
        return this.inFlight.get(token)
    }

    setInFlight(token: string, promise: Promise<CacheEntry>): void {
        this.inFlight.set(token, promise)
    }

    removeInFlight(token: string): void {
        this.inFlight.delete(token)
    }

    cacheEntry(token: string, user: AuthUser): CacheEntry {
        if (this.cache.size >= 500) {
            const now = Date.now()
            for (const [k, v] of this.cache.entries()) {
                if (v.expiresAt <= now) this.cache.delete(k)
            }
        }
        const entry: CacheEntry = { ...user, expiresAt: Date.now() + this.ttl }
        this.cache.set(token, entry)
        return entry
    }
}
