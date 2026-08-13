import { ConfigService } from '@nestjs/config'

import { TokenCacheService } from './token-cache.service'
import type { AuthUser } from './auth.guard'

const USER: AuthUser = { userId: 'user-1', login: 'octocat', name: null, avatarUrl: null }

function makeCache(ttl = 300_000): TokenCacheService {
    const config = { get: jest.fn().mockReturnValue(ttl) } as unknown as ConfigService
    return new TokenCacheService(config)
}

describe('TokenCacheService hard bound', () => {
    it('never exceeds 500 entries even when every entry is live', () => {
        const cache = makeCache()
        for (let i = 0; i < 501; i++) cache.cacheEntry(`token-${i}`, USER)

        // The 501st insert evicted exactly the oldest-inserted live entry.
        expect(cache.getCached('token-0')).toBeUndefined()
        expect(cache.getCached('token-1')).toBeDefined()
        expect(cache.getCached('token-500')).toBeDefined()
    })

    it('keeps evicting the oldest-inserted entry as more live tokens arrive', () => {
        const cache = makeCache()
        for (let i = 0; i < 600; i++) cache.cacheEntry(`token-${i}`, USER)

        for (let i = 0; i < 100; i++) expect(cache.getCached(`token-${i}`)).toBeUndefined()
        expect(cache.getCached('token-100')).toBeDefined()
        expect(cache.getCached('token-599')).toBeDefined()
    })

    it('re-caching a token refreshes its position so it is not evicted early', () => {
        const cache = makeCache()
        for (let i = 0; i < 500; i++) cache.cacheEntry(`token-${i}`, USER)
        cache.cacheEntry('token-0', USER) // refresh — moves to the newest position
        cache.cacheEntry('token-500', USER) // evicts token-1, not token-0

        expect(cache.getCached('token-0')).toBeDefined()
        expect(cache.getCached('token-1')).toBeUndefined()
    })

    it('sweeps expired entries at the cap instead of evicting live ones', () => {
        jest.useFakeTimers()
        try {
            const cache = makeCache(60_000)
            jest.setSystemTime(1_000_000)
            for (let i = 0; i < 500; i++) cache.cacheEntry(`stale-${i}`, USER)

            jest.setSystemTime(1_000_000 + 61_000) // all 500 entries are now expired
            cache.cacheEntry('fresh', USER) // triggers the expired sweep
            expect(cache.getCached('fresh')).toBeDefined()

            // The sweep freed real room: 499 more live inserts fit without evicting 'fresh'.
            for (let i = 0; i < 499; i++) cache.cacheEntry(`later-${i}`, USER)
            expect(cache.getCached('fresh')).toBeDefined()
            expect(cache.getCached('later-498')).toBeDefined()
        } finally {
            jest.useRealTimers()
        }
    })
})
