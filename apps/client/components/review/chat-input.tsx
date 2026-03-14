'use client'

import { useEffect, useState, useCallback } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Constants ─────────────────────────────────────────────────────────────────

const SHOW_PX = 160   // show when this close to the bottom
const HIDE_PX = 320   // hide only once this far away (hysteresis)

// ── Chat Input ────────────────────────────────────────────────────────────────
// Renders as a fixed viewport overlay when the user scrolls near the bottom.
// scrollContainerRef is optional — when omitted, falls back to window scroll,
// so this works on both bounded (h-screen) and natural (min-h-screen) pages.

interface ChatInputProps {
    value: string
    onChange: (v: string) => void
    onSubmit: () => void
    disabled?: boolean
    scrollContainerRef?: React.RefObject<HTMLDivElement | null>
}

export function ChatInput({ value, onChange, onSubmit, disabled, scrollContainerRef }: ChatInputProps) {
    const [isVisible, setIsVisible] = useState(false)
    const [isFocused, setIsFocused] = useState(false)

    const checkVisibility = useCallback(() => {
        const container = scrollContainerRef?.current ?? null
        const dist = container
            ? container.scrollHeight - container.scrollTop - container.clientHeight
            : document.documentElement.scrollHeight - window.scrollY - window.innerHeight
        setIsVisible(prev => prev ? dist < HIDE_PX : dist < SHOW_PX)
    }, [scrollContainerRef])

    useEffect(() => {
        const target: EventTarget = scrollContainerRef?.current ?? window
        target.addEventListener('scroll', checkVisibility, { passive: true })
        checkVisibility()
        return () => target.removeEventListener('scroll', checkVisibility)
    }, [checkVisibility, scrollContainerRef])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
        }
    }

    if (!isVisible) return null

    return (
        <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center px-6 pb-5 pt-8
                        bg-gradient-to-t from-[#0d1117] via-[#0d1117]/75 to-transparent
                        pointer-events-none
                        animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="w-full max-w-3xl pointer-events-auto">
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
// Pure presentational component. Can be used standalone if needed.

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
                'flex items-center gap-3 rounded-[20px] px-5 py-3',
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
                        // Two-step resize: reset to auto so it can shrink, then set to scrollHeight.
                        e.target.style.height = 'auto'
                        e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
                    }}
                    onFocus={onFocus}
                    onBlur={onBlur}
                    onKeyDown={onKeyDown}
                    placeholder="Reply to better DEV..."
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
                    className="shrink-0 w-[30px] h-[30px] rounded-[10px] flex items-center justify-center
                               bg-blue-600 hover:bg-blue-500 active:scale-95
                               disabled:opacity-25 disabled:cursor-not-allowed transition-all duration-150"
                >
                    <ArrowUp className="w-[15px] h-[15px] text-white" strokeWidth={2.5} />
                </button>
            </div>
        </form>
    )
}
