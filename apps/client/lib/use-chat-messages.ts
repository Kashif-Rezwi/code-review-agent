'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '@/lib/api'
import { consumeSSEStream } from '@/lib/sse'
import type { ChatMessage } from '@/types/review.types'

type ChatStreamEvent =
    | { type: 'delta'; text: string }
    | { type: 'done' }
    | { type: 'error'; message: string }

interface UseChatMessages {
    messages: ChatMessage[]
    input: string
    setInput: (v: string) => void
    isSending: boolean
    /** Non-null while the assistant response is streaming in token-by-token. */
    streamingContent: string | null
    submit: () => Promise<void>
}

export function useChatMessages(
    reviewId: string | null,
    initialMessages?: ChatMessage[],
    githubToken?: string,
): UseChatMessages {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input, setInput] = useState('')
    const [isSending, setIsSending] = useState(false)
    const [streamingContent, setStreamingContent] = useState<string | null>(null)

    const seeded = useRef(false)
    // Ref guard — lets submit read isSending without adding it to useCallback deps
    const isSendingRef = useRef(false)

    // Reset all state when the review changes — prevents cross-session message bleed
    // (React never unmounts this hook between review sessions on the same page)
    useEffect(() => {
        setMessages([])
        setInput('')
        setIsSending(false)
        setStreamingContent(null)
        isSendingRef.current = false
        seeded.current = false
    }, [reviewId])

    // Seed from history (history page) — always runs after the reset above
    useEffect(() => {
        if (initialMessages && !seeded.current) {
            setMessages(initialMessages)
            seeded.current = true
        }
    }, [initialMessages])

    const submit = useCallback(async () => {
        const message = input.trim()
        if (!message || isSendingRef.current || !reviewId) return

        // Optimistic user message
        setMessages(prev => [...prev, { role: 'user', content: message }])
        setInput('')
        isSendingRef.current = true
        setIsSending(true)
        setStreamingContent('')  // empty string = "connected, waiting for first token"

        let accumulated = ''
        try {
            const res = await fetch(`${API_URL}/history/${reviewId}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
                },
                body: JSON.stringify({ message }),
            })

            if (!res.ok || !res.body) {
                const errText = await res.text().catch(() => `HTTP ${res.status}`)
                throw new Error(errText)
            }

            const reader = res.body.getReader()
            let streamError: string | null = null
            await consumeSSEStream<ChatStreamEvent>(reader, event => {
                if (event.type === 'delta') {
                    accumulated += event.text
                    setStreamingContent(accumulated)
                } else if (event.type === 'error') {
                    streamError = event.message
                }
            })

            if (streamError) throw new Error(streamError)
            setMessages(prev => [...prev, { role: 'assistant', content: accumulated }])
        } catch {
            setMessages(prev => [
                ...prev,
                { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' },
            ])
        } finally {
            isSendingRef.current = false
            setStreamingContent(null)
            setIsSending(false)
        }
    }, [reviewId, input])

    return { messages, input, setInput, isSending, streamingContent, submit }
}
