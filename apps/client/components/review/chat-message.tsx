'use client'

import { Copy, Check } from 'lucide-react'
import { useCopyToClipboard } from '@/lib/hooks'

// ── Types ────────────────────────────────────────────────────────────────────

export type Segment =
    | { type: 'text'; content: string }
    | { type: 'code'; lang: string; content: string }

// ── Markdown parser ──────────────────────────────────────────────────────────

/** Split raw text into alternating text / fenced-code-block segments. */
export function parseSegments(raw: string): Segment[] {
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

// ── Rendering primitives ─────────────────────────────────────────────────────

/** Renders inline backtick code spans inside a text run. */
export function InlineText({ text }: { text: string }) {
    const parts = text.split(/`([^`\n]+)`/)
    return (
        <>
            {parts.map((part, i) =>
                i % 2 === 1 ? (
                    <code key={i} className="bg-gray-900 border border-gray-800 rounded px-1 py-0.5 text-xs font-mono text-gray-300">
                        {part}
                    </code>
                ) : (
                    part
                ),
            )}
        </>
    )
}

export function TextSegment({ content }: { content: string }) {
    const trimmed = content.trim()
    if (!trimmed) return null

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

export function CodeBlock({ lang, content }: { lang: string; content: string }) {
    const { copied, copy } = useCopyToClipboard()
    return (
        <div className="rounded-lg overflow-hidden border border-gray-800 my-2">
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d1117] border-b border-gray-800">
                <span className="text-xs text-gray-600 font-mono">{lang}</span>
                <button
                    onClick={() => copy(content)}
                    className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-300 transition-colors"
                >
                    {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            <pre className="bg-[#0d1117] px-4 py-3 overflow-x-auto text-xs font-mono text-gray-400 leading-relaxed">
                <code>{content}</code>
            </pre>
        </div>
    )
}

/** Renders an assistant message with formatted text and code blocks. */
export function AssistantMessage({ content }: { content: string }) {
    const segments = parseSegments(content)
    return (
        <div className="text-sm text-gray-300 space-y-1">
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

/** Right-aligned user chat bubble. */
export function UserBubble({ content }: { content: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[75%] rounded-lg px-3 py-2 text-sm leading-relaxed
                            bg-blue-500/15 border border-blue-500/20 text-blue-100">
                {content}
            </div>
        </div>
    )
}

/** Pulsing dots loading indicator for pending assistant responses. */
export function LoadingIndicator() {
    return (
        <div className="flex items-center gap-1.5 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce [animation-delay:300ms]" />
        </div>
    )
}
