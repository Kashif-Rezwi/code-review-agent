// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewService } from './api'
import { useReviewStream } from './use-review-stream'

function stream(frames: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(frames))
            controller.close()
        },
    })
}

describe('useReviewStream reconnect', () => {
    afterEach(() => vi.restoreAllMocks())

    it('resumes from Last-Event-ID and preserves reducer progress', async () => {
        vi.spyOn(reviewService, 'getSession').mockResolvedValue({ type: 'PR', input: 'https://github.com/a/b/pull/1' })
        const fetchMock = vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(stream([
                'id: 10-1',
                'event: thinking',
                'data: {"type":"thinking","text":"Inspecting files"}',
                '',
                '',
            ].join('\n')), { status: 200 }))
            .mockResolvedValueOnce(new Response(stream([
                'id: 10-2',
                'event: complete',
                'data: {"type":"complete","review":{"id":"review-1","summary":"Safe","score":9,"issues":[],"positives":[]},"durationMs":10,"stepCount":1,"outcome":"complete"}',
                '',
                '',
            ].join('\n')), { status: 200 }))

        const { result } = renderHook(() => useReviewStream('review-1'))
        await waitFor(() => expect(result.current.phase).toBe('complete'), { timeout: 3_000 })

        expect(result.current.traceEntries).toHaveLength(1)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>
        expect(secondHeaders['Last-Event-ID']).toBe('10-1')
    })
})
