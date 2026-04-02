import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common'
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
    private readonly token?: string

    constructor(
        config: ConfigService,
        private readonly cache: GithubCacheService
    ) {
        this.token = config.get<string>('GITHUB_TOKEN')
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

        const res = await (this.token
            ? this.fetchViaApi(owner, repo, number)
            : this.fetchViaDirect(owner, repo, number))

        this.assertOk(res, prUrl)

        const diff = await res.text()

        // Guard against private repos returning an HTML login page
        if (diff.trimStart().startsWith('<')) {
            throw new BadRequestException(
                `Could not read diff for ${prUrl}. The repository may be private — set a GITHUB_TOKEN.`,
            )
        }

        if (diff.length > MAX_DIFF_CHARS) {
            return diff.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated — PR is too large to review in full]'
        }

        return diff || 'No diff found — the PR may have no changed files.'
    }

    async fetchPRFiles(prUrl: string): Promise<PRFile[]> {
        const { owner, repo, number } = parsePRUrl(prUrl)
        const headers = this.buildHeaders('application/vnd.github.v3+json')
        const allFiles: PRFile[] = []

        let url: string | null =
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`

        // Paginate through all pages (GitHub caps at 100 files per page).
        while (url) {
            const res = await fetch(url, { headers })
            this.assertOk(res, prUrl)

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

        const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${qsRef}`,
            { headers: this.buildHeaders('application/vnd.github.v3+json') },
        )

        if (res.status === 404) {
            throw new BadRequestException(
                `File not found in repository: ${filePath}`,
            )
        }
        this.assertOk(res, prUrl)

        const data = await res.json()

        if (data.encoding !== 'base64' || typeof data.content !== 'string') {
            throw new BadRequestException(
                `Unexpected GitHub API response for file: ${filePath}`,
            )
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
            const res = await fetch(
                `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
                { headers: this.buildHeaders('application/vnd.github.v3+json') },
            )
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
    private buildHeaders(accept: string): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: accept,
            'User-Agent': 'code-review-agent/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
        }
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`
        return headers
    }

    /** Throw a descriptive BadRequestException for common GitHub HTTP error codes. */
    private assertOk(res: Response, prUrl: string): void {
        if (res.status === 404) throw new BadRequestException(
            `PR not found: ${prUrl}. Check the repository is public and the PR number is correct.`,
        )
        if (res.status === 401 || res.status === 403) throw new BadRequestException(
            `Access denied to ${prUrl}. Private repositories require a GITHUB_TOKEN.`,
        )
        if (res.status === 429) throw new BadRequestException(
            `GitHub rate limit exceeded. Set a GITHUB_TOKEN to increase limits.`,
        )
        if (!res.ok) throw new BadRequestException(
            `GitHub returned ${res.status} for ${prUrl}.`,
        )
    }

    /**
     * Authenticated path — REST API with diff Accept header.
     * Supports private repos; benefits from the 5 000 req/hr token rate limit.
     */
    private fetchViaApi(owner: string, repo: string, number: number) {
        return fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
            { headers: this.buildHeaders('application/vnd.github.diff') },
        )
    }

    /**
     * Unauthenticated path — GitHub's direct .diff URL.
     * Not subject to the strict 60 req/hr API limit; reliable for public repos
     * in shared-IP environments (Vercel, Railway, etc.).
     */
    private fetchViaDirect(owner: string, repo: string, number: number) {
        return fetch(
            `https://github.com/${owner}/${repo}/pull/${number}.diff`,
            { headers: { 'User-Agent': 'code-review-agent/1.0' } },
        )
    }
}
