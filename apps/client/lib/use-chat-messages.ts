import { useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api'
import type { ChatMessage } from '@/types/review.types'

interface UseChatMessages {
    messages: ChatMessage[]
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
    input: string
    setInput: (v: string) => void
    isSending: boolean
    submit: () => Promise<void>
}

/**
 * Manages chat messages for a review session.
 *
 * `setMessages` is exposed so the caller can seed initial messages
 * (e.g. from a persisted history fetch) without a second network call.
 *
 * `reviewId` may be null while the review is still loading — `submit`
 * is a no-op until it resolves.
 */
export function useChatMessages(reviewId: string | null): UseChatMessages {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input,    setInput]    = useState('')
    const [isSending, setIsSending] = useState(false)

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

    return { messages, setMessages, input, setInput, isSending, submit }
}
