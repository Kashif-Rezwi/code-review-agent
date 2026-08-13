import { InternalServerErrorException, Logger } from '@nestjs/common'
import { ProviderStreamError } from './ai-runtime.adapter'
import { isTransientProviderError, waitBeforeProviderRetry, withProviderRetry } from './provider-backoff'

beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => jest.restoreAllMocks())

describe('isTransientProviderError', () => {
    it('flags HTTP 429 and 5xx status codes', () => {
        expect(isTransientProviderError({ statusCode: 429 })).toBe(true)
        expect(isTransientProviderError({ statusCode: 503 })).toBe(true)
        expect(isTransientProviderError({ error: { status: 500 } })).toBe(true)
    })

    it('flags quota/rate-limit error codes and messages', () => {
        expect(isTransientProviderError(new ProviderStreamError('RESOURCE_EXHAUSTED', 'Quota exceeded', 429))).toBe(true)
        expect(isTransientProviderError(new Error('Rate limit reached for requests'))).toBe(true)
    })

    it('does not flag auth/billing failures, parse failures, or our own HTTP exceptions', () => {
        expect(isTransientProviderError(new ProviderStreamError('billing_not_active', 'Your account is not active'))).toBe(false)
        expect(isTransientProviderError(new InternalServerErrorException('The model did not return a valid review.'))).toBe(false)
        expect(isTransientProviderError(new Error('unexpected'))).toBe(false)
    })
})

describe('waitBeforeProviderRetry', () => {
    it('returns false immediately for non-transient errors', async () => {
        const start = Date.now()
        await expect(waitBeforeProviderRetry(new Error('bad output'), 1)).resolves.toBe(false)
        expect(Date.now() - start).toBeLessThan(100)
    })

    it('honors the provider Retry-After header and returns true', async () => {
        const start = Date.now()
        await expect(
            waitBeforeProviderRetry({ statusCode: 429, responseHeaders: { 'retry-after': '0.05' } }, 1),
        ).resolves.toBe(true)
        expect(Date.now() - start).toBeGreaterThanOrEqual(40)
    })

    it('rejects with the abort reason when the signal fires mid-wait', async () => {
        const controller = new AbortController()
        const wait = waitBeforeProviderRetry({ statusCode: 429 }, 1, { signal: controller.signal, baseDelayMs: 30_000 })
        controller.abort(new Error('cancelled'))
        await expect(wait).rejects.toThrow('cancelled')
    })

    it('extracts Retry-After from the SDK RetryError lastError', async () => {
        const start = Date.now()
        const retryError = {
            message: 'Failed after 2 attempts.',
            lastError: { statusCode: 429, responseHeaders: { 'retry-after': '0.05' } },
        }
        await expect(waitBeforeProviderRetry(retryError, 1)).resolves.toBe(true)
        expect(Date.now() - start).toBeGreaterThanOrEqual(40)
    })

    it('parses the Google message-text retry hint', async () => {
        const start = Date.now()
        const error = new Error('Failed after 2 attempts. Last error: Quota exceeded... Please retry in 0.05s.')
        await expect(waitBeforeProviderRetry(error, 1)).resolves.toBe(true)
        expect(Date.now() - start).toBeGreaterThanOrEqual(40)
    })

    it('classifies RetryError-wrapped 429s as transient', () => {
        expect(isTransientProviderError({ message: 'Failed after 2 attempts.', lastError: { statusCode: 429 } })).toBe(true)
    })
})

describe('withProviderRetry', () => {
    it('retries a transient failure once and then succeeds', async () => {
        const fn = jest.fn()
            .mockRejectedValueOnce({ statusCode: 429, responseHeaders: { 'retry-after': '0' } })
            .mockResolvedValueOnce('ok')
        await expect(withProviderRetry(fn)).resolves.toBe('ok')
        expect(fn).toHaveBeenCalledTimes(2)
    })

    it('rethrows non-transient errors without retrying', async () => {
        const fn = jest.fn().mockRejectedValue(new InternalServerErrorException('parse failed'))
        await expect(withProviderRetry(fn)).rejects.toThrow('parse failed')
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('stops after the configured attempts', async () => {
        const error = { statusCode: 429, responseHeaders: { 'retry-after': '0' } }
        const fn = jest.fn().mockRejectedValue(error)
        await expect(withProviderRetry(fn, { attempts: 3 })).rejects.toBe(error)
        expect(fn).toHaveBeenCalledTimes(3)
    })
})