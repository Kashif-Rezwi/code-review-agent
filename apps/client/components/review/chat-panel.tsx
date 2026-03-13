'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageCircle, Send, Copy, Check } from 'lucide-react'

interface Message {
    role: 'user' | 'assistant'
    content: string
}

interface ChatPanelProps {
    reviewId: string
    initialMessages?: Message[]
}

// ── Markdown parser ──────────────────────────────────────────────────────────

type Segment =
    | { type: 'text'; content: string }
    | { type: 'code'; lang: string; content: string }

/**
 * Split a string into alternating text / fenced-code-block segments.
 * Handles ```lang\n...\n``` patterns; falls back to a single text segment.
 */
function parseSegments(raw: string): Segment[] {
    const segments: Segment[] = []
    const fence = /```(\w*)\n([\s\S]*?)```/g
    let cursor = 0
    let match: RegExpExecArray | null

    while ((match = fence.exec(raw)) !== null) {
        if (match.index > cursor) {
            segments.push({ type: 'text', content: raw.slice(cursor, match.index) })
        }
        segments.push({ type: 'code', lang: match[1] || 'code', content: match[2].trimEnd() })
        cursor = fence.lastIndex
    }

    if (cursor < raw.length) {
        segments.push({ type: 'text', content: raw.slice(cursor) })
    }

    return segments.length ? segments : [{ type: 'text', content: raw }]
}

// ── Sub-components ───────────────────────────────────────────────────────────

function InlineText({ text }: { text: string }) {
    // Render inline backtick code spans
    const parts = text.split(/`([^`\n]+)`/)
    return (
        <>
            {parts.map((part, i) =>
                i % 2 === 1 ? (
                    <code
                        key={i}
                        className="bg-gray-700 rounded px-1 py-0.5 text-xs font-mono text-gray-200"
                    >
                        {part}
                    </code>
                ) : (
                    part
                ),
            )}
        </>
    )
}

function TextSegment({ content }: { content: string }) {
    const trimmed = content.trim()
    if (!trimmed) return null

    // Split into paragraphs on blank lines
    return (
        <div className="space-y-1.5">
            {trimmed.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="leading-relaxed">
                    <InlineText text={para.replace(/\n/g, ' ')} />
                </p>
            ))}
        </div>
    )
}

function CodeBlock({ lang, content }: { lang: string; content: string }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
        await navigator.clipboard.writeText(content)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="rounded-lg overflow-hidden border border-gray-800/70 my-2">
            {/* Header: blends with the page — same base dark as #0d1117 */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d1117] border-b border-gray-800/60">
                <span className="text-xs text-gray-500 font-mono">{lang}</span>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-300 transition-colors"
                >
                    {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            {/* Code body: same page-level dark so editor feels embedded, not boxed */}
            <pre className="bg-[#0d1117] px-4 py-3 overflow-x-auto text-xs font-mono text-gray-300 leading-relaxed">
                <code>{content}</code>
            </pre>
        </div>
    )
}

function AssistantMessage({ content }: { content: string }) {
    const segments = parseSegments(content)
    return (
        <div className="text-sm text-gray-200 space-y-1">
            {segments.map((seg, i) =>
                seg.type === 'code' ? (
                    <CodeBlock key={i} lang={seg.lang} content={seg.content} />
                ) : (
                    <TextSegment key={i} content={seg.content} />
                ),
            )}
        </div>
    )
}

// ── Main component ───────────────────────────────────────────────────────────

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
            {/* Header */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
                <MessageCircle className="w-4 h-4 text-blue-400" />
                <span className="text-sm font-medium text-white">Ask a follow-up question</span>
            </div>

            {/* Messages */}
            {(messages.length > 0 || isLoading) && (
                <div className="px-4 py-3 space-y-4 max-h-[520px] overflow-y-auto">
                    {messages.map((msg, i) =>
                        msg.role === 'user' ? (
                            /* User bubble — right-aligned */
                            <div key={i} className="flex justify-end">
                                <div className="max-w-[75%] rounded-lg px-3 py-2 text-sm leading-relaxed bg-blue-600 text-white">
                                    {msg.content}
                                </div>
                            </div>
                        ) : (
                            /* Assistant — full-width card with formatted content */
                            <div key={i} className="w-full rounded-lg px-4 py-3 bg-gray-800/60 border border-gray-700/60">
                                <AssistantMessage content={msg.content} />
                            </div>
                        ),
                    )}

                    {isLoading && (
                        <div className="w-full rounded-lg px-4 py-3 bg-gray-800/60 border border-gray-700/60">
                            <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                        </div>
                    )}

                    <div ref={bottomRef} />
                </div>
            )}

            {/* Input bar */}
            <form
                onSubmit={handleSubmit}
                className="flex items-center gap-2 px-4 py-3 border-t border-gray-800"
            >
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
