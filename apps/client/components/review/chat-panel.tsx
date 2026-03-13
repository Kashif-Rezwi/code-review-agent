'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircle, Send } from 'lucide-react'

interface Message {
    role: 'user' | 'assistant'
    content: string
}

interface ChatPanelProps {
    reviewId: string
    initialMessages?: Message[]
}

export function ChatPanel({ reviewId, initialMessages = [] }: ChatPanelProps) {
    const [messages, setMessages] = useState<Message[]>(initialMessages)
    const [input, setInput] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const bottomRef = useRef<HTMLDivElement>(null)
    const apiUrl = process.env.NEXT_PUBLIC_API_URL

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        const message = input.trim()
        if (!message || isLoading) return

        setInput('')
        setMessages((prev) => [...prev, { role: 'user', content: message }])
        setIsLoading(true)

        try {
            const res = await fetch(`${apiUrl}/history/${reviewId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
            })

            if (!res.ok) throw new Error('Failed to get a response.')
            const data = await res.json()
            setMessages((prev) => [...prev, { role: 'assistant', content: data.content }])
        } catch {
            setMessages((prev) => [
                ...prev,
                { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' },
            ])
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="rounded-xl border border-gray-700 bg-gray-900/60 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
                <MessageCircle className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium text-white">Ask a follow-up question</span>
            </div>

            {messages.length > 0 && (
                <div className="px-4 py-3 space-y-3 max-h-80 overflow-y-auto">
                    {messages.map((msg, i) => (
                        <div
                            key={i}
                            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div
                                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
                                    msg.role === 'user'
                                        ? 'bg-blue-600 text-white'
                                        : 'bg-gray-800 text-gray-200 border border-gray-700'
                                }`}
                            >
                                {msg.content}
                            </div>
                        </div>
                    ))}
                    {isLoading && (
                        <div className="flex justify-start">
                            <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                            </div>
                        </div>
                    )}
                    <div ref={bottomRef} />
                </div>
            )}

            <form onSubmit={handleSubmit} className="flex items-center gap-2 px-4 py-3 border-t border-gray-800">
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder='e.g. "How do I fix the null check issue?"'
                    disabled={isLoading}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2
                               text-sm text-gray-100 placeholder-gray-600
                               focus:outline-none focus:border-blue-500 transition-colors
                               disabled:opacity-50"
                />
                <button
                    type="submit"
                    disabled={isLoading || !input.trim()}
                    className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                               disabled:cursor-not-allowed transition-colors text-white"
                >
                    <Send className="w-4 h-4" />
                </button>
            </form>
        </div>
    )
}
