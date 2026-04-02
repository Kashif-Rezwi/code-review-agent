import { BadRequestException } from '@nestjs/common'

/**
 * Extracts owner, repo, and PR number from a standard GitHub PR URL.
 * Throws a BadRequestException if the URL format is invalid.
 */
export function parsePRUrl(url: string): { owner: string; repo: string; number: number } {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) {
        throw new BadRequestException(
            'Invalid GitHub PR URL. Expected: https://github.com/owner/repo/pull/123',
        )
    }
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) }
}

/**
 * Decodes base64 content received from the GitHub API.
 * Safely strips injected newlines from the base64 string before decoding.
 */
export function decodeGitHubFileBase64(content: string): string {
    return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf-8')
}
