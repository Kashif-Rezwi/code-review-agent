'use client'

import { Copy, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { useCopyToClipboard } from '@/lib/hooks'
import { Button } from '@/components/ui/button'

export function CodeBlock({ lang, content }: { lang: string; content: string }) {
    const { copied, copy } = useCopyToClipboard()
    return (
        <div data-code-block className="rounded-lg overflow-hidden border border-gray-800 my-2">
            <div className="flex items-center justify-between px-3 py-1.5 bg-app-bg border-b border-gray-800">
                <span className="text-xs text-gray-600 font-mono">{lang}</span>
                <Button
                    variant="ghost-icon"
                    size="sm"
                    onClick={() => copy(content)}
                    className="gap-1 text-xs"
                >
                    {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <pre className="bg-app-bg px-4 py-3 overflow-x-auto text-xs font-mono text-gray-400 leading-relaxed">
                <code>{content}</code>
            </pre>
        </div>
    )
}

// Module-level for a stable reference — prevents ReactMarkdown from re-reconciling on every render
const CHAT_MD_COMPONENTS: Components = {
    // CodeBlock provides its own container, so strip the default <pre> wrapper
    pre: ({ children }) => <>{children}</>,

    // Route fenced blocks through CodeBlock; inline backticks get their own style.
    code({ className, children }) {
        const lang = /language-([\w.+-]+)/.exec(className || '')?.[1]
        const isBlock = !!lang || String(children).includes('\n')
        if (isBlock) {
            return <CodeBlock lang={lang || 'code'} content={String(children).trimEnd()} />
        }
        return (
            <code className="bg-gray-900 border border-gray-800 rounded px-1 py-0.5 text-xs font-mono text-gray-300">
                {children}
            </code>
        )
    },

    // Headings
    h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-4 mb-2 first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-semibold text-white mt-3 mb-1.5">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-200 mt-2 mb-1">{children}</h3>,

    // Paragraphs & lists
    p: ({ children }) => <p className="leading-relaxed mb-2 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,

    // Inline emphasis
    strong: ({ children }) => <strong className="font-semibold text-gray-200">{children}</strong>,
    em: ({ children }) => <em className="italic text-gray-300">{children}</em>,

    // Links, dividers, blockquotes
    a: ({ href, children }) => (
        <a href={href} className="text-blue-400 hover:text-blue-300 underline" target="_blank" rel="noopener noreferrer">
            {children}
        </a>
    ),
    hr: () => <hr className="border-gray-800 my-3" />,
    blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-gray-700 pl-3 text-gray-400 italic my-2">
            {children}
        </blockquote>
    ),
}

// ── AssistantMessage ──────────────────────────────────────────────────────────

export function AssistantMessage({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
    // No tokens yet — show a lone blinking cursor for immediate feedback
    if (isStreaming && content === '') {
        return (
            <div className="text-sm text-gray-300">
                <span className="text-gray-400 [animation:cursor-blink_0.75s_step-end_infinite]">▍</span>
            </div>
        )
    }

    return (
        // data-streaming activates the CSS cursor via globals.css [data-streaming]::after
        <div className="text-sm text-gray-300" data-streaming={isStreaming || undefined}>
            <ReactMarkdown components={CHAT_MD_COMPONENTS}>
                {content}
            </ReactMarkdown>
        </div>
    )
}

// ── UserBubble ────────────────────────────────────────────────────────────────

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

// ── LoadingIndicator ──────────────────────────────────────────────────────────
// Shown while waiting for the first streaming token to arrive.

export function LoadingIndicator() {
    return (
        <div className="flex items-center gap-1.5 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce [animation-delay:300ms]" />
        </div>
    )
}
