import { Injectable, BadRequestException, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common'
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
import { parseUnifiedDiff } from './unified-diff.parser'
import type { GithubTokenHealth, NormalizedPRFile, PRSnapshot } from './github.types'

const MAX_RAW_DIFF_BYTES = 2 * 1024 * 1024
const GITHUB_TIMEOUT_MS = 10_000
const MAX_RETRY_DELAY_MS = 2_000

@Injectable()
export class GithubService implements OnModuleInit {
    private readonly logger = new Logger(GithubService.name)
    private readonly token?: string
    private tokenHealth: GithubTokenHealth

    constructor(
        config: ConfigService,
        private readonly cache: GithubCacheService,
    ) {
        // Render and other hosting dashboards preserve whitespace literally. An empty
        // or padded token should never produce a malformed Authorization header.
        this.token = config.get<string>('GITHUB_TOKEN')?.trim() || undefined
        this.tokenHealth = this.token ? 'unchecked' : 'missing'
    }

    onModuleInit(): void {
        // Health validation is diagnostic only. Public PR review remains available
        // through the direct diff fallback even when the shared token is rejected.
        void this.validateConfiguredToken()
    }

    getTokenHealth(): GithubTokenHealth {
        return this.tokenHealth
    }

    /** Called by ReviewService before the agent loop to short-circuit on bad URLs. Throws BadRequestException on invalid input. */
    assertValidPRUrl(url: string): void {
        parsePRUrl(url)
    }

    async fetchUserProfile(token: string): Promise<GithubUserResponse> {
        const res = await this.fetchWithPolicy('https://api.github.com/user', {
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

    /**
     * Acquire a normalized, per-file PR snapshot. Both the structured REST path
     * and the unified-diff fallback produce the same contract, so acquisition
     * availability never changes the review strategy.
     */
    async fetchPRSnapshot(prUrl: string): Promise<PRSnapshot> {
        let apiFiles: PRFile[] | null = null
        const warnings: string[] = []

        try {
            apiFiles = await this.fetchPRFiles(prUrl)
        } catch (error) {
            warnings.push(`GitHub file-list request failed: ${this.errorMessage(error)}`)
        }

        if (apiFiles?.length) {
            const files = apiFiles.map((file) => this.normalizeApiFile(file))
            const missingPatchFiles = files.filter((file) => file.patchState === 'metadata_only')

            if (missingPatchFiles.length > 0) {
                try {
                    const parsed = parseUnifiedDiff(await this.fetchPRDiff(prUrl))
                    warnings.push(...parsed.warnings)
                    this.mergeParsedPatches(files, parsed.files)
                } catch (error) {
                    warnings.push(
                        `Could not enrich ${missingPatchFiles.length} patchless file(s): ${this.errorMessage(error)}`,
                    )
                }
            }

            const unresolved = files.filter((file) => file.patchState === 'metadata_only')
            if (unresolved.length > 0) {
                warnings.push(`${unresolved.length} file(s) are available as metadata only.`)
            }

            return {
                files,
                source: 'github_files_api',
                complete: unresolved.length === 0,
                warnings: this.uniqueWarnings(warnings),
            }
        }

        if (apiFiles && apiFiles.length === 0) {
            warnings.push('GitHub file-list request returned no changed files.')
        }

        // The structured endpoint has already exhausted authenticated and
        // anonymous API access. Move directly to GitHub's raw public diff so a
        // bad shared token cannot force the model-facing fallback path.
        let parsed: ReturnType<typeof parseUnifiedDiff>
        try {
            parsed = parseUnifiedDiff(await this.fetchPublicPRDiff(prUrl))
        } catch (error) {
            const diagnostic = warnings.length > 0 ? `${warnings.join(' ')} ` : ''
            throw new BadRequestException(
                `Pull-request acquisition failed. ${diagnostic}` +
                    `Public diff fallback failed: ${this.errorMessage(error)}`,
            )
        }
        warnings.push(...parsed.warnings)
        if (parsed.files.length === 0) {
            throw new BadRequestException('No reviewable files could be parsed from the GitHub pull request diff.')
        }

        const metadataOnly = parsed.files.filter((file) => file.patchState === 'metadata_only')
        if (metadataOnly.length > 0) warnings.push(`${metadataOnly.length} file(s) are available as metadata only.`)

        return {
            files: parsed.files,
            source: 'public_diff',
            complete: metadataOnly.length === 0,
            warnings: this.uniqueWarnings(warnings),
        }
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
                throw new BadRequestException(
                    `GitHub diff acquisition failed. Authenticated attempt: ${this.errorMessage(authenticatedError)} ` +
                        `Public attempt: ${this.errorMessage(publicError)}`,
                )
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

        const res = await this.fetchWithPolicy(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${qsRef}`, {
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
            const res = await this.fetchWithPolicy(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
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
        const response = await this.fetchWithPolicy(url, {
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

        const publicResponse = await this.fetchWithPolicy(url, {
            headers: this.buildHeaders(accept, false),
        })
        if (publicResponse.ok) {
            this.logger.warn('Unauthenticated GitHub fallback succeeded')
            return { response: publicResponse, usedPublicFallback: true }
        }

        const publicError = this.responseError(publicResponse, prUrl)
        this.logger.error(`Unauthenticated GitHub fallback also failed (${publicResponse.status})`)
        throw new BadRequestException(
            `GitHub file-list acquisition failed. Authenticated attempt: ${authenticatedError.message} ` +
                `Public attempt: ${publicError.message}`,
        )
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
                `PR not found or not accessible (404): ${prUrl}. ` +
                    `Check the URL and private-repository access.${context}`,
            )
        }

        return new BadRequestException(`GitHub returned ${res.status} while fetching ${prUrl}.${context}`)
    }

    private async readDiffResponse(res: Response, prUrl: string): Promise<string> {
        const diff = await this.readTextWithLimit(res, MAX_RAW_DIFF_BYTES)

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
        return this.fetchWithPolicy(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
            headers: this.buildHeaders('application/vnd.github.diff'),
        })
    }

    /**
     * Unauthenticated path — GitHub's direct .diff URL.
     * Not subject to the strict 60 req/hr API limit; reliable for public repos
     * in shared-IP environments (Vercel, Railway, etc.).
     */
    private fetchViaDirect(owner: string, repo: string, number: number) {
        return this.fetchWithPolicy(`https://github.com/${owner}/${repo}/pull/${number}.diff`, {
            headers: { 'User-Agent': 'code-review-agent/1.0' },
        })
    }

    private async fetchPublicPRDiff(prUrl: string): Promise<string> {
        const { owner, repo, number } = parsePRUrl(prUrl)
        const response = await this.fetchViaDirect(owner, repo, number)
        this.assertOk(response, prUrl)
        return this.readDiffResponse(response, prUrl)
    }

    private normalizeApiFile(file: PRFile): NormalizedPRFile {
        const patch = file.patch?.trim() ? file.patch : undefined
        return {
            ...file,
            patch,
            previousFilename: file.previous_filename,
            patchState: patch ? 'full' : 'metadata_only',
        }
    }

    private mergeParsedPatches(target: NormalizedPRFile[], parsed: NormalizedPRFile[]): void {
        const byName = new Map<string, NormalizedPRFile>()
        for (const file of parsed) {
            byName.set(file.filename, file)
            if (file.previousFilename) byName.set(file.previousFilename, file)
        }

        for (const file of target) {
            if (file.patchState !== 'metadata_only') continue
            const fallback = byName.get(file.filename) ?? (file.previousFilename ? byName.get(file.previousFilename) : undefined)
            if (!fallback) continue
            file.patch = fallback.patch
            file.patchState = fallback.patchState
            file.previousFilename ??= fallback.previousFilename
        }
    }

    private uniqueWarnings(warnings: string[]): string[] {
        return [...new Set(warnings.filter(Boolean))]
    }

    private async validateConfiguredToken(): Promise<void> {
        if (!this.token) {
            this.tokenHealth = 'missing'
            return
        }

        try {
            const response = await this.fetchWithPolicy('https://api.github.com/rate_limit', {
                headers: this.buildHeaders('application/vnd.github+json'),
            })
            this.tokenHealth = response.ok ? 'valid' : 'invalid'
            if (!response.ok) this.logger.warn(`Configured GITHUB_TOKEN validation returned ${response.status}`)
        } catch (error) {
            this.tokenHealth = 'unchecked'
            this.logger.warn(`Could not validate configured GITHUB_TOKEN: ${this.errorMessage(error)}`)
        }
    }

    private async readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
        if (!response.body) {
            const text = await response.text()
            if (Buffer.byteLength(text, 'utf8') > maxBytes) throw this.diffTooLargeError(maxBytes)
            return text
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let bytes = 0
        let output = ''

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                bytes += value.byteLength
                if (bytes > maxBytes) {
                    await reader.cancel()
                    throw this.diffTooLargeError(maxBytes)
                }
                output += decoder.decode(value, { stream: true })
            }
            output += decoder.decode()
            return output
        } finally {
            reader.releaseLock()
        }
    }

    private diffTooLargeError(maxBytes: number): BadRequestException {
        return new BadRequestException(
            `The pull request diff is too large to acquire safely (${Math.floor(maxBytes / 1024 / 1024)} MiB limit).`,
        )
    }

    private async fetchWithPolicy(url: string, init: RequestInit): Promise<Response> {
        let lastError: unknown

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetch(url, {
                    ...init,
                    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
                })
                if (attempt === 0 && this.isRetryableStatus(response)) {
                    await this.waitBeforeRetry(response)
                    continue
                }
                return response
            } catch (error) {
                lastError = error
                if (attempt === 0) {
                    await this.waitBeforeRetry()
                    continue
                }
            }
        }

        throw lastError instanceof Error ? lastError : new Error('GitHub request failed')
    }

    private isRetryableStatus(response: Response): boolean {
        return response.status === 429 || response.status >= 500 ||
            (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    }

    private async waitBeforeRetry(response?: Response): Promise<void> {
        if (process.env.NODE_ENV === 'test') return
        const retryAfterSeconds = Number(response?.headers.get('retry-after'))
        const fromHeader = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 0
        const delay = Math.min(MAX_RETRY_DELAY_MS, fromHeader || Math.floor(250 + Math.random() * 750))
        await new Promise((resolve) => setTimeout(resolve, delay))
    }
}
