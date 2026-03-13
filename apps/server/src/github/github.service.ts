import { Injectable, BadRequestException } from '@nestjs/common'
import type { PRFile } from '@cra/ai'
import { ConfigService } from '@nestjs/config'

const MAX_DIFF_CHARS = 24_000

@Injectable()
export class GithubService {
    private readonly token?: string

    constructor(private config: ConfigService) {
        this.token = this.config.get<string>('GITHUB_TOKEN')
    }

    /** Called by ReviewService before the agent loop to short-circuit on bad URLs. */
    validatePRUrl(url: string): void {
        this.parsePRUrl(url)
    }

    private parsePRUrl(url: string): { owner: string; repo: string; number: number } {
        const match = url.match(
            /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
        )
        if (!match) {
            throw new BadRequestException(
                'Invalid GitHub PR URL. Expected: https://github.com/owner/repo/pull/123',
            )
        }
        return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) }
    }

    async fetchPRDiff(prUrl: string): Promise<string> {
        const { owner, repo, number } = this.parsePRUrl(prUrl)

        const res = await (this.token
            ? this.fetchViaApi(owner, repo, number)
            : this.fetchViaDirect(owner, repo, number))

        if (res.status === 404) {
            throw new BadRequestException(
                `PR not found: ${prUrl}. Check the repository is public and the PR number is correct.`,
            )
        }
        if (res.status === 401 || res.status === 403) {
            throw new BadRequestException(
                `Access denied to ${prUrl}. Private repositories require a GITHUB_TOKEN environment variable.`,
            )
        }
        if (res.status === 429) {
            throw new BadRequestException(
                `GitHub rate limit exceeded. Set a GITHUB_TOKEN environment variable to increase limits.`,
            )
        }
        if (!res.ok) {
            throw new BadRequestException(`GitHub returned ${res.status} for ${prUrl}.`)
        }

        const diff = await res.text()

        // Guard against private repos returning an HTML login page
        if (diff.trimStart().startsWith('<')) {
            throw new BadRequestException(
                `Could not read diff for ${prUrl}. The repository may be private — set a GITHUB_TOKEN environment variable.`,
            )
        }

        if (diff.length > MAX_DIFF_CHARS) {
            return diff.slice(0, MAX_DIFF_CHARS) + '\n\n[diff truncated — PR is too large to review in full]'
        }

        return diff || 'No diff found — the PR may have no changed files.'
    }

    /**
     * Authenticated path — uses the REST API.
     * Supports private repos and benefits from the 5000 req/hr token rate limit.
     */
    private fetchViaApi(owner: string, repo: string, number: number) {
        return fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
            {
                headers: {
                    Accept: 'application/vnd.github.diff',
                    Authorization: `Bearer ${this.token}`,
                    'User-Agent': 'code-review-agent/1.0',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            },
        )
    }

    async fetchPRFiles(prUrl: string): Promise<PRFile[]> {
        const { owner, repo, number } = this.parsePRUrl(prUrl)
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'code-review-agent/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
        }
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`

        const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=30`,
            { headers },
        )

        if (res.status === 404) throw new BadRequestException(`PR not found: ${prUrl}`)
        if (res.status === 401 || res.status === 403) {
            throw new BadRequestException(`Access denied to ${prUrl}. Set a GITHUB_TOKEN environment variable.`)
        }
        if (res.status === 429) {
            throw new BadRequestException('GitHub rate limit exceeded. Set a GITHUB_TOKEN environment variable.')
        }
        if (!res.ok) throw new BadRequestException(`GitHub returned ${res.status} for ${prUrl}.`)

        const files = await res.json()
        return files.map((f: Record<string, unknown>) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
        }))
    }

    /**
     * Unauthenticated path — uses GitHub's direct .diff URL.
     * Not subject to the strict 60 req/hr API rate limit, so it works reliably
     * in shared-IP environments (Vercel, Railway, etc.) for public repositories.
     */
    private fetchViaDirect(owner: string, repo: string, number: number) {
        return fetch(
            `https://github.com/${owner}/${repo}/pull/${number}.diff`,
            {
                headers: { 'User-Agent': 'code-review-agent/1.0' },
            },
        )
    }
}
