'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowUp, ChevronUp, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ChatInputProps {
    value: string
    onChange: (v: string) => void
    onSubmit: () => void
    disabled?: boolean
    /** Observe this element — input appears when it enters the viewport */
    chatSectionRef?: React.RefObject<HTMLElement | null>
    /** Whether the viewport is already at the bottom (hides the ↓ Latest button) */
    isAtBottom?: boolean
    /** Scrolls up to the review output (above the chat) */
    onScrollToReview?: () => void
    /** Scrolls down to the latest message */
    onScrollToLatest?: () => void
}

export function ChatInput({
    value, onChange, onSubmit, disabled,
    chatSectionRef, isAtBottom = true,
    onScrollToReview, onScrollToLatest,
}: ChatInputProps) {
    const [isVisible, setIsVisible] = useState(false)
    const [isFocused, setIsFocused] = useState(false)

    // Show when the chat section sentinel enters the viewport.
    useEffect(() => {
        const el = chatSectionRef?.current
        if (!el) { setIsVisible(true); return }
        const observer = new IntersectionObserver(
            ([entry]) => setIsVisible(entry.isIntersecting),
            { threshold: 0 },
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [chatSectionRef])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
        }
    }

    if (!isVisible) return null

    const showNav = onScrollToReview || (onScrollToLatest && !isAtBottom)

    return (
        <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center px-6 pb-5 pt-8
                        bg-gradient-to-t from-app-bg via-app-bg/75 to-transparent
                        pointer-events-none
                        animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="w-full max-w-4xl pointer-events-auto flex flex-col gap-2">

                {/* ── Navigation pills ── */}
                {showNav && (
                    <div className="flex justify-end gap-1.5">
                        {onScrollToReview && (
                            <button
                                onClick={onScrollToReview}
                                title="Jump to review"
                                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs
                                           bg-gray-900/80 border border-white/[0.07] text-gray-500
                                           hover:text-gray-200 hover:border-gray-600/50
                                           backdrop-blur-sm transition-all duration-150"
                            >
                                <ChevronUp className="w-3 h-3" />
                                Review
                            </button>
                        )}
                        {onScrollToLatest && !isAtBottom && (
                            <button
                                onClick={onScrollToLatest}
                                title="Jump to latest message"
                                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs
                                           bg-gray-900/80 border border-white/[0.07] text-gray-500
                                           hover:text-gray-200 hover:border-gray-600/50
                                           backdrop-blur-sm transition-all duration-150"
                            >
                                Latest
                                <ChevronDown className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                )}

                {/* ── Input shell ── */}
                <InputShell
                    value={value}
                    onChange={onChange}
                    onSubmit={onSubmit}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    onKeyDown={handleKeyDown}
                    disabled={disabled}
                    isFocused={isFocused}
                />
            </div>
        </div>
    )
}

// ── Input Shell ───────────────────────────────────────────────────────────────

interface InputShellProps {
    value: string
    onChange: (v: string) => void
    onSubmit: () => void
    onFocus?: () => void
    onBlur?: () => void
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
    disabled?: boolean
    isFocused?: boolean
}

export function InputShell({ value, onChange, onSubmit, onFocus, onBlur, onKeyDown, disabled, isFocused }: InputShellProps) {
    return (
        <form onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
            <div className={cn(
                'flex items-center gap-3 rounded-xl px-5 py-3',
                'bg-gray-900/75 backdrop-blur-xl border transition-all duration-200',
                isFocused
                    ? 'border-gray-600/50 shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_8px_40px_rgba(0,0,0,0.55)]'
                    : 'border-white/[0.07] shadow-[0_4px_28px_rgba(0,0,0,0.45)]',
            )}>
                <textarea
                    rows={1}
                    value={value}
                    onChange={(e) => {
                        onChange(e.target.value)
                        e.target.style.height = 'auto'
                        e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
                    }}
                    onFocus={onFocus}
                    onBlur={onBlur}
                    onKeyDown={onKeyDown}
                    placeholder="Ask a follow-up question…"
                    disabled={disabled}
                    className="flex-1 resize-none bg-transparent text-sm text-gray-100
                               placeholder-gray-500 leading-[1.5] focus:outline-none
                               disabled:opacity-50 min-h-[22px] max-h-[120px] overflow-y-auto
                               py-0 align-middle"
                    style={{ height: '22px' }}
                />
                <button
                    type="submit"
                    disabled={disabled || !value.trim()}
                    className="shrink-0 w-[30px] h-[30px] rounded-lg flex items-center justify-center
                               bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 hover:border-blue-400/50
                               shadow-[0_0_10px_rgba(59,130,246,0.15)] hover:shadow-[0_0_15px_rgba(59,130,246,0.25)]
                               active:scale-95 disabled:opacity-25 disabled:cursor-not-allowed transition-all duration-200"
                >
                    <ArrowUp className="w-[15px] h-[15px] text-white" strokeWidth={2.5} />
                </button>
            </div>
        </form>
    )
}
