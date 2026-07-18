import { Injectable, BadRequestException, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { z } from 'zod'
import { PRFileSchema } from '@cra/ai'
import type { PRFile } from '@cra/ai'

export interface GithubUserResponse {
    id: number
    login: string
    name: string | null
    email: string | null
    avatar_url: string
}
import { parsePRUrl, decodeGitHubFileBase64 } from './github.utils'
import { GithubCacheService } from './github-cache.service'

const MAX_DIFF_CHARS = 24_000

@Injectable()
export class GithubService {
    private readonly logger = new Logger(GithubService.name)
    private readonly token?: string

    constructor(
        config: ConfigService,
        private readonly cache: GithubCacheService,
    ) {
        // Render and other hosting dashboards preserve whitespace literally. An empty
        // or padded token should never produce a malformed Authorization header.
        this.token = config.get<string>('GITHUB_TOKEN')?.trim() || undefined
    }

    /** Called by ReviewService before the agent loop to short-circuit on bad URLs. Throws BadRequestException on invalid input. */
    assertValidPRUrl(url: string): void {
        parsePRUrl(url)
    }

    async fetchUserProfile(token: string): Promise<GithubUserResponse> {
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

        return (await res.json()) as GithubUserResponse
    }

    async fetchPRDiff(prUrl: string): Promise<string> {
        const { owner, repo, number } = parsePRUrl(prUrl)
        let authenticatedError: unknown

        // Prefer the authenticated REST endpoint for private repositories and a
        // higher rate limit. If the configured token is invalid or GitHub rejects
        // the request, still try GitHub's public .diff endpoint before giving up.
        if (this.token) {
            try {
                const res = await this.fetchViaApi(owner, repo, number)
                this.assertOk(res, prUrl)
                return await this.readDiffResponse(res, prUrl)
            } catch (err) {
                authenticatedError = err
                this.logger.warn(
                    `Authenticated PR diff fetch failed for ${owner}/${repo}#${number}; ` +
                        `trying public .diff fallback: ${this.errorMessage(err)}`,
                )
            }
        }

        try {
            const res = await this.fetchViaDirect(owner, repo, number)
            this.assertOk(res, prUrl)
            const diff = await this.readDiffResponse(res, prUrl)
            if (authenticatedError) {
                this.logger.warn(`Public .diff fallback succeeded for ${owner}/${repo}#${number}`)
            }
            return diff
        } catch (publicError) {
            if (authenticatedError) {
                this.logger.error(
                    `Both authenticated and public PR diff fetches failed for ` +
                        `${owner}/${repo}#${number}; public error: ${this.errorMessage(publicError)}`,
                )
                // The authenticated error normally contains the most useful diagnosis
                // (invalid token, rate limit, or missing repository access).
                throw authenticatedError
            }
            throw publicError
        }
    }

    async fetchPRFiles(prUrl: string): Promise<PRFile[]> {
        const { owner, repo, number } = parsePRUrl(prUrl)
        const allFiles: PRFile[] = []
        let preferAuthenticatedRequest = !!this.token

        let url: string | null = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`

        // Paginate through all pages (GitHub caps at 100 files per page).
        while (url) {
            const { response: res, usedPublicFallback } = await this.fetchApiResource(
                url,
                'application/vnd.github.v3+json',
                prUrl,
                preferAuthenticatedRequest,
            )
            // Once GitHub has rejected the configured token and the public request
            // succeeds, keep the remaining pagination requests unauthenticated.
            if (usedPublicFallback) preferAuthenticatedRequest = false

            const raw = await res.json()
            let page: PRFile[]
            try {
                page = z.array(PRFileSchema).parse(raw)
            } catch {
                throw new BadRequestException('Unexpected GitHub API response format for file list')
            }
            allFiles.push(...page)

            // Follow the "next" link if the API returned multiple pages.
            const link = res.headers.get('link') ?? ''
            const next = link.match(/<([^>]+)>;\s*rel="next"/)
            url = next ? next[1] : null
        }

        return allFiles
    }

    /**
     * Fetch the full source of any file in the repository.
     * Used by the autonomous review agent to investigate imports, called
     * functions, or base classes when the diff alone is not enough.
     * Response content from GitHub Contents API is base64-encoded.
     */
    async fetchFileContent(prUrl: string, filePath: string): Promise<string> {
        const { owner, repo, number } = parsePRUrl(prUrl)

        // Fetch from the PR's head branch (not the default branch) so we get
        // the actual version of the file as it exists in the PR.
        const ref = await this.fetchPRHeadRef(owner, repo, number)
        const qsRef = ref ? `?ref=${encodeURIComponent(ref)}` : ''

        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${qsRef}`, {
            headers: this.buildHeaders('application/vnd.github.v3+json'),
        })

        if (res.status === 404) {
            throw new BadRequestException(`File not found in repository: ${filePath}`)
        }
        this.assertOk(res, prUrl)

        const data = await res.json()

        if (data.encoding !== 'base64' || typeof data.content !== 'string') {
            throw new BadRequestException(`Unexpected GitHub API response for file: ${filePath}`)
        }

        // GitHub embeds newlines in the base64 string — strip before decoding
        const content = decodeGitHubFileBase64(data.content)

        const MAX_FILE_CHARS = 8_000
        if (content.length > MAX_FILE_CHARS) {
            return (
                content.slice(0, MAX_FILE_CHARS) +
                `\n\n[file truncated — ${content.length} chars total, showing first ${MAX_FILE_CHARS}]`
            )
        }

        return content || `(empty file: ${filePath})`
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /** Get the head commit SHA of a PR so fetchFileContent reads the PR's version. */
    private async fetchPRHeadRef(owner: string, repo: string, number: number): Promise<string | null> {
        const key = `${owner}/${repo}/${number}`
        const cached = this.cache.getHeadRef(key)
        if (cached) return cached
        try {
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
                headers: this.buildHeaders('application/vnd.github.v3+json'),
            })
            if (!res.ok) return null
            const data = await res.json()
            const sha = data?.head?.sha as string | undefined
            if (sha) {
                this.cache.setHeadRef(key, sha)
            }
            return sha ?? null
        } catch {
            return null
        }
    }

    /** Build GitHub API request headers. `accept` varies per endpoint. */
    private buildHeaders(accept: string, includeToken = true): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: accept,
            'User-Agent': 'code-review-agent/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
        }
        if (includeToken && this.token) headers['Authorization'] = `Bearer ${this.token}`
        return headers
    }

    /**
     * Fetch a GitHub REST resource. When a configured token is rejected, retry
     * once without credentials so public repositories remain reviewable. The
     * original authenticated error is retained if the public retry also fails.
     */
    private async fetchApiResource(
        url: string,
        accept: string,
        prUrl: string,
        preferAuthenticatedRequest: boolean,
    ): Promise<{ response: Response; usedPublicFallback: boolean }> {
        const useToken = preferAuthenticatedRequest && !!this.token
        const response = await fetch(url, {
            headers: this.buildHeaders(accept, useToken),
        })

        if (response.ok) return { response, usedPublicFallback: false }

        const authenticatedError = this.responseError(response, prUrl)
        if (!useToken || !this.canRetryAsPublic(response.status)) {
            throw authenticatedError
        }

        this.logger.warn(
            `Authenticated GitHub request failed (${response.status}); ` +
                `retrying without credentials for public repository access`,
        )

        const publicResponse = await fetch(url, {
            headers: this.buildHeaders(accept, false),
        })
        if (publicResponse.ok) {
            this.logger.warn('Unauthenticated GitHub fallback succeeded')
            return { response: publicResponse, usedPublicFallback: true }
        }

        this.logger.error(`Unauthenticated GitHub fallback also failed (${publicResponse.status})`)
        throw authenticatedError
    }

    private canRetryAsPublic(status: number): boolean {
        return status === 401 || status === 403 || status === 404 || status === 429
    }

    /** Throw a descriptive BadRequestException for common GitHub HTTP error codes. */
    private assertOk(res: Response, prUrl: string): void {
        if (!res.ok) throw this.responseError(res, prUrl)
    }

    private responseError(res: Response, prUrl: string): BadRequestException {
        const requestId = res.headers.get('x-github-request-id')
        const context = requestId ? ` GitHub request ID: ${requestId}.` : ''
        const remaining = res.headers.get('x-ratelimit-remaining')
        const retryAfter = res.headers.get('retry-after')
        const reset = res.headers.get('x-ratelimit-reset')

        if (res.status === 401) {
            return new BadRequestException(
                `GitHub rejected the configured GITHUB_TOKEN (401). ` +
                    `The token may be invalid, expired, or revoked.${context}`,
            )
        }

        if (res.status === 429 || (res.status === 403 && remaining === '0')) {
            const retry = retryAfter
                ? ` Retry after ${retryAfter} seconds.`
                : reset
                  ? ` Rate limit resets at Unix time ${reset}.`
                  : ''
            return new BadRequestException(`GitHub API rate limit exceeded.${retry}${context}`)
        }

        if (res.status === 403) {
            return new BadRequestException(
                `GitHub denied access to ${prUrl} (403). ` +
                    `Check the token's repository access and read permissions.${context}`,
            )
        }

        if (res.status === 404) {
            return new BadRequestException(
                `PR not found or not accessible: ${prUrl}. ` + `Check the URL and private-repository access.${context}`,
            )
        }

        return new BadRequestException(`GitHub returned ${res.status} while fetching ${prUrl}.${context}`)
    }

    private async readDiffResponse(res: Response, prUrl: string): Promise<string> {
        const diff = await res.text()

        // Guard against private repositories returning an HTML login page.
        if (diff.trimStart().startsWith('<')) {
            throw new BadRequestException(
                `Could not read diff for ${prUrl}. The repository may be private or inaccessible.`,
            )
        }

        if (!diff.trim()) {
            throw new BadRequestException(
                `No reviewable diff was found for ${prUrl}. The PR may have no changed files.`,
            )
        }

        if (diff.length > MAX_DIFF_CHARS) {
            return diff.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated — PR is too large to review in full]'
        }

        return diff
    }

    private errorMessage(err: unknown): string {
        return err instanceof Error ? err.message : String(err)
    }

    /**
     * Authenticated path — REST API with diff Accept header.
     * Supports private repos; benefits from the 5 000 req/hr token rate limit.
     */
    private fetchViaApi(owner: string, repo: string, number: number) {
        return fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
            headers: this.buildHeaders('application/vnd.github.diff'),
        })
    }

    /**
     * Unauthenticated path — GitHub's direct .diff URL.
     * Not subject to the strict 60 req/hr API limit; reliable for public repos
     * in shared-IP environments (Vercel, Railway, etc.).
     */
    private fetchViaDirect(owner: string, repo: string, number: number) {
        return fetch(`https://github.com/${owner}/${repo}/pull/${number}.diff`, {
            headers: { 'User-Agent': 'code-review-agent/1.0' },
        })
    }
}
