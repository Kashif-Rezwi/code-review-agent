import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api'
import type { ChatMessage } from '@/types/review.types'

interface UseChatMessages {
    messages: ChatMessage[]
    input: string
    setInput: (v: string) => void
    isSending: boolean
    submit: () => Promise<void>
}

/**
 * Manages chat messages for a review session.
 *
 * `initialMessages` seeds the list once — useful when replaying a
 * persisted history fetch without exposing the internal state setter.
 *
 * `reviewId` may be null while the review is still loading — `submit`
 * is a no-op until it resolves.
 */
export function useChatMessages(
    reviewId: string | null,
    initialMessages?: ChatMessage[],
): UseChatMessages {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input,    setInput]    = useState('')
    const [isSending, setIsSending] = useState(false)

    // Seed initial messages exactly once — runs when initialMessages first
    // becomes available (e.g. after the history fetch resolves).
    const seeded = useRef(false)
    useEffect(() => {
        if (initialMessages && !seeded.current) {
            setMessages(initialMessages)
            seeded.current = true
        }
    }, [initialMessages])

    const submit = useCallback(async () => {
        const message = input.trim()
        if (!message || isSending || !reviewId) return

        setInput('')
        setMessages(prev => [...prev, { role: 'user', content: message }])
        setIsSending(true)

        try {
            const data = await apiFetch<ChatMessage>(`/history/${reviewId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            })
            setMessages(prev => [...prev, data])
        } catch {
            setMessages(prev => [
                ...prev,
                { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' },
            ])
        } finally {
            setIsSending(false)
        }
    }, [reviewId, input, isSending])

    return { messages, input, setInput, isSending, submit }
}
