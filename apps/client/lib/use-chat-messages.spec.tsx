// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useChatMessages } from './use-chat-messages'

describe('useChatMessages error surfacing', () => {
    afterEach(() => vi.restoreAllMocks())

    it('renders the real server error message in the assistant bubble', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ message: 'GitHub token is invalid or expired.' }),
            { status: 401 },
        ))

        const { result } = renderHook(() => useChatMessages('review-1', [], 'gh-token'))
        act(() => result.current.setInput('hello'))
        await act(async () => { await result.current.submit() })

        expect(result.current.messages).toEqual([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'Something went wrong: GitHub token is invalid or expired.' },
        ])
    })

    it('falls back to the generic copy when the error carries no message', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error())

        const { result } = renderHook(() => useChatMessages('review-1', [], 'gh-token'))
        act(() => result.current.setInput('hello'))
        await act(async () => { await result.current.submit() })

        expect(result.current.messages.at(-1)).toEqual({
            role: 'assistant',
            content: 'Sorry, something went wrong. Please try again.',
        })
    })
})
