import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface UseReviewScrollOptions {
    threshold?: number
    smoothScrollDuration?: number
    isStreaming?: boolean
}

/**
 * Unified auto-scroll management during AI review streaming: isAtBottom detection, ResizeObserver
 * tracking of content expansion, and programmatic scroll locking to prevent user/script "warring".
 */
export function useReviewScroll({
    threshold = 120,
    smoothScrollDuration = 350,
    isStreaming = false,
}: UseReviewScrollOptions = {}) {
    const [isAtBottom, setIsAtBottom] = useState(true)
    const isAtBottomRef = useRef(true)
    const isProgrammaticRef = useRef(false)
    const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const bottomRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLElement>(null)

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
        if (!bottomRef.current) return

        isProgrammaticRef.current = true
        bottomRef.current.scrollIntoView({ behavior })

        if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = setTimeout(() => {
            isProgrammaticRef.current = false
        }, behavior === 'smooth' ? smoothScrollDuration : 50)
    }, [smoothScrollDuration])

    // Suppress browser native scroll jump on reloads and force a clean 0 state.
    // using useLayoutEffect ensures it fires synchronously before the browser paints.
    useLayoutEffect(() => {
        if (typeof window !== 'undefined') {
            if ('scrollRestoration' in window.history) {
                window.history.scrollRestoration = 'manual'
            }
            window.scrollTo(0, 0)
            
            // Minor safeguard against Next.js router injecting delayed scroll-restores
            requestAnimationFrame(() => window.scrollTo(0, 0))
        }
    }, [])

    useEffect(() => {
        const onScroll = () => {
            if (isProgrammaticRef.current) return
            const { scrollTop, scrollHeight, clientHeight } = document.documentElement
            const atBottom = scrollHeight - scrollTop - clientHeight < threshold
            isAtBottomRef.current = atBottom
            setIsAtBottom(atBottom)
        }

        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [threshold])

    useEffect(() => {
        const content = contentRef.current
        if (!content) return

        let lastHeight = content.scrollHeight
        const observer = new ResizeObserver(() => {
            const newHeight = content.scrollHeight
            if (newHeight > lastHeight && isAtBottomRef.current && isStreaming) {
                scrollToBottom('instant')
            }
            lastHeight = newHeight
        })

        observer.observe(content)
        return () => observer.disconnect()
    }, [isStreaming, scrollToBottom])

    return {
        bottomRef,
        contentRef,
        scrollToBottom,
        isAtBottom,
        isAtBottomRef,
    }
}
