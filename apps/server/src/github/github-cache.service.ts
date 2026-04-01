import { Injectable } from '@nestjs/common'

@Injectable()
export class GithubCacheService {
    private static readonly HEAD_REF_CACHE_MAX = 100
    private readonly headRefCache = new Map<string, string>()

    getHeadRef(key: string): string | undefined {
        return this.headRefCache.get(key)
    }

    setHeadRef(key: string, sha: string): void {
        // Evict the oldest entry when the cap is reached (Map preserves insertion order).
        if (this.headRefCache.size >= GithubCacheService.HEAD_REF_CACHE_MAX) {
            const oldest = this.headRefCache.keys().next().value
            if (oldest) this.headRefCache.delete(oldest)
        }
        this.headRefCache.set(key, sha)
    }
}
