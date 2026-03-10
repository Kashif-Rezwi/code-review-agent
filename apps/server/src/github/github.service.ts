import { Injectable, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

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

        const headers: Record<string, string> = {
            Accept: 'application/vnd.github.v3.diff',
            'User-Agent': 'code-review-agent/1.0',
        }
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`
        }

        const res = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
            { headers },
        )

        if (res.status === 404) {
            throw new BadRequestException(
                `PR not found: ${prUrl}. Ensure the repo is public and the PR number is correct.`,
            )
        }
        if (res.status === 403) {
            throw new BadRequestException(
                `Access denied to ${prUrl}. Private repos require a GITHUB_TOKEN env variable.`,
            )
        }
        if (!res.ok) {
            throw new BadRequestException(
                `GitHub API returned ${res.status} for ${prUrl}`,
            )
        }

        const diff = await res.text()

        // Guard against massive PRs — keep within token budget (~6k tokens)
        const MAX_CHARS = 24_000
        if (diff.length > MAX_CHARS) {
            return (
                diff.slice(0, MAX_CHARS) +
                '\n\n[diff truncated — PR is too large to review in full]'
            )
        }

        return diff || 'No diff found — the PR may have no changed files.'
    }
}
