import { BadRequestException } from '@nestjs/common'

/** Extract owner, repo, and PR number from a GitHub PR URL; throws BadRequestException on invalid input. */
export function parsePRUrl(url: string): { owner: string; repo: string; number: number } {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) {
        throw new BadRequestException(
            'Invalid GitHub PR URL. Expected: https://github.com/owner/repo/pull/123',
        )
    }
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) }
}
