import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiErrorMessage } from './api'

describe('apiErrorMessage', () => {
    it('extracts Nest message fields instead of displaying raw JSON', async () => {
        const response = new Response(JSON.stringify({
            message: 'Database schema is not ready',
            error: 'Internal Server Error',
            statusCode: 500,
        }), { status: 500 })

        await expect(apiErrorMessage(response)).resolves.toBe('Database schema is not ready')
    })
})

describe('apiFetch configuration guard', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    it('throws a clear error instead of issuing a same-origin request when NEXT_PUBLIC_API_URL is empty', async () => {
        vi.stubEnv('NEXT_PUBLIC_API_URL', '')
        vi.resetModules()
        const { apiFetch } = await import('./api')
        const fetchSpy = vi.spyOn(globalThis, 'fetch')

        await expect(apiFetch('/history')).rejects.toThrow('NEXT_PUBLIC_API_URL is not configured')
        expect(fetchSpy).not.toHaveBeenCalled()
    })
})
