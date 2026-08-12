import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { AuthUser } from './auth.guard'

export interface CacheEntry extends AuthUser {
    expiresAt: number
}

/** Hard upper bound on cached token resolutions. */
const MAX_CACHE_ENTRIES = 500

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
        // Refresh insertion order — Map position drives the oldest-first eviction below.
        this.cache.delete(token)
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
            const now = Date.now()
            for (const [k, v] of this.cache.entries()) {
                if (v.expiresAt <= now) this.cache.delete(k)
            }
            // Hard bound: when every entry is still live, evict the oldest-inserted
            // entries (Map preserves insertion order) until there is room.
            while (this.cache.size >= MAX_CACHE_ENTRIES) {
                const oldestKey = this.cache.keys().next().value as string | undefined
                if (oldestKey === undefined) break
                this.cache.delete(oldestKey)
            }
        }
        const entry: CacheEntry = { ...user, expiresAt: Date.now() + this.ttl }
        this.cache.set(token, entry)
        return entry
    }
}
