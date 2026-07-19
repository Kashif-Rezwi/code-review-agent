import { BadRequestException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { GithubService } from './github.service'

const PR_URL = 'https://github.com/vercel/next.js/pull/91191'
const FILES_API_URL = 'https://api.github.com/repos/vercel/next.js/pulls/91191/files?per_page=100'
const DIRECT_DIFF_URL = 'https://github.com/vercel/next.js/pull/91191.diff'

const changedFile = {
    filename: 'packages/next/src/example.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-old\n+new',
}

const unifiedDiff = [
    'diff --git a/packages/next/src/example.ts b/packages/next/src/example.ts',
    '--- a/packages/next/src/example.ts',
    '+++ b/packages/next/src/example.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
].join('\n')

function createService(token?: string): GithubService {
    const config = {
        get: jest.fn((key: string) => (key === 'GITHUB_TOKEN' ? token : undefined)),
    } as unknown as ConfigService
    return new GithubService(config)
}

function response(body: string, status: number, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers })
}

describe('GithubService normalized PR acquisition', () => {
    let fetchSpy: jest.SpiedFunction<typeof fetch>

    beforeEach(() => {
        fetchSpy = jest.spyOn(global, 'fetch')
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => jest.restoreAllMocks())

    it('moves from authenticated 401 to an anonymous files request without retrying the 401', async () => {
        fetchSpy
            .mockResolvedValueOnce(response('{"message":"Bad credentials"}', 401, { 'x-github-request-id': 'AUTH-1' }))
            .mockResolvedValueOnce(response(JSON.stringify([changedFile]), 200, { 'content-type': 'application/json' }))

        await expect(createService('configured-token').fetchPRFiles(PR_URL)).resolves.toEqual([changedFile])

        expect(fetchSpy).toHaveBeenCalledTimes(2)
        expect(fetchSpy.mock.calls[0]?.[0]).toBe(FILES_API_URL)
        expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer configured-token')
        expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Authorization')).toBeNull()
    })

    it('retains authenticated and anonymous diagnostics, then parses the public diff into files', async () => {
        fetchSpy
            .mockResolvedValueOnce(response('{"message":"Bad credentials"}', 401, { 'x-github-request-id': 'AUTH-401' }))
            .mockResolvedValueOnce(response('{"message":"Forbidden"}', 403, { 'x-github-request-id': 'PUBLIC-403' }))
            .mockResolvedValueOnce(response(unifiedDiff, 200, { 'content-type': 'text/plain' }))

        const result = await createService('expired-token').fetchPRSnapshot(PR_URL)

        expect(fetchSpy).toHaveBeenCalledTimes(3)
        expect(fetchSpy.mock.calls[2]?.[0]).toBe(DIRECT_DIFF_URL)
        expect(result.source).toBe('public_diff')
        expect(result.files).toEqual([
            expect.objectContaining({ filename: 'packages/next/src/example.ts', patchState: 'full' }),
        ])
        expect(result.warnings.join(' ')).toMatch(/401.*AUTH-401/i)
        expect(result.warnings.join(' ')).toMatch(/403.*PUBLIC-403/i)
        expect(result.warnings.join(' ')).not.toContain('expired-token')
    })

    it('retains both file-list diagnostics when the public diff also fails', async () => {
        fetchSpy
            .mockResolvedValueOnce(response('{"message":"Bad credentials"}', 401, { 'x-github-request-id': 'AUTH-FAIL' }))
            .mockResolvedValueOnce(response('{"message":"Forbidden"}', 403, { 'x-github-request-id': 'PUBLIC-FAIL' }))
            .mockResolvedValueOnce(response('Not Found', 404, { 'x-github-request-id': 'DIFF-FAIL' }))

        await expect(createService('configured-token').fetchPRSnapshot(PR_URL)).rejects.toThrow(
            /401.*AUTH-FAIL.*403.*PUBLIC-FAIL.*public diff fallback failed.*404.*DIFF-FAIL/i,
        )
    })

    it('retries a transient or rate-limited request once with the same credentials', async () => {
        fetchSpy
            .mockResolvedValueOnce(response('{"message":"server error"}', 500))
            .mockResolvedValueOnce(response(JSON.stringify([changedFile]), 200, { 'content-type': 'application/json' }))

        await expect(createService('configured-token').fetchPRFiles(PR_URL)).resolves.toEqual([changedFile])
        expect(fetchSpy).toHaveBeenCalledTimes(2)
        expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer configured-token')
    })

    it('fills missing API patches from the parsed diff and keeps binary files explicit', async () => {
        const apiFiles = [
            { ...changedFile, patch: undefined },
            { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 },
        ]
        const diff = `${unifiedDiff}\n` + [
            'diff --git a/assets/logo.png b/assets/logo.png',
            'new file mode 100644',
            'Binary files /dev/null and b/assets/logo.png differ',
        ].join('\n')
        fetchSpy
            .mockResolvedValueOnce(response(JSON.stringify(apiFiles), 200, { 'content-type': 'application/json' }))
            .mockResolvedValueOnce(response(diff, 200, { 'content-type': 'text/plain' }))

        const result = await createService().fetchPRSnapshot(PR_URL)

        expect(result.source).toBe('github_files_api')
        expect(result.files[0]).toEqual(expect.objectContaining({ patchState: 'full', patch: expect.stringContaining('+new') }))
        expect(result.files[1]).toEqual(expect.objectContaining({ filename: 'assets/logo.png', patchState: 'binary' }))
        expect(result.files[1].patch).toBeUndefined()
    })

    it('fails safely when a raw diff exceeds two MiB', async () => {
        fetchSpy.mockResolvedValueOnce(response(`diff --git a/a.ts b/a.ts\n${'x'.repeat(2 * 1024 * 1024)}`, 200))

        await expect(createService().fetchPRDiff(PR_URL)).rejects.toThrow(/too large to acquire safely.*2 MiB/i)
    })

    it('treats a whitespace-only token as missing', async () => {
        fetchSpy.mockResolvedValueOnce(response(JSON.stringify([changedFile]), 200, { 'content-type': 'application/json' }))

        const service = createService('   ')
        await expect(service.fetchPRFiles(PR_URL)).resolves.toEqual([changedFile])
        expect(service.getTokenHealth()).toBe('missing')
        expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('Authorization')).toBeNull()
    })

    it('updates the startup token diagnostic without exposing the token', async () => {
        fetchSpy.mockResolvedValueOnce(response('{"message":"Bad credentials"}', 401))
        const service = createService('private-token-value')

        await (service as unknown as { validateConfiguredToken(): Promise<void> }).validateConfiguredToken()

        expect(service.getTokenHealth()).toBe('invalid')
        expect(JSON.stringify(service.getTokenHealth())).not.toContain('private-token-value')
    })

    it('rejects an HTML page returned in place of a public diff', async () => {
        fetchSpy.mockResolvedValueOnce(response('<!doctype html><title>Sign in</title>', 200, { 'content-type': 'text/html' }))

        const request = createService().fetchPRDiff(PR_URL)
        await expect(request).rejects.toBeInstanceOf(BadRequestException)
    })
})
