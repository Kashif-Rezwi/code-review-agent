'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const OVERSCAN = 10

/**
 * Fixed-height virtual scroll hook. Tracks the container's scroll position and
 * dimensions, then returns the slice of indices that should actually be rendered.
 *
 * The inner spacer div must be given height = totalHeight so the scrollbar
 * accurately reflects the full list length. Items are absolutely positioned
 * at top = index * rowHeight.
 */
export function useVirtualScroll(itemCount: number, rowHeight: number) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [scrollTop, setScrollTop] = useState(0)
    const [containerHeight, setContainerHeight] = useState(500)

    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        setContainerHeight(el.clientHeight)
        const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight))
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    const onScroll = useCallback(() => {
        if (containerRef.current) setScrollTop(containerRef.current.scrollTop)
    }, [])

    const totalHeight = itemCount * rowHeight
    const visibleStart = Math.floor(scrollTop / rowHeight)
    const visibleEnd = Math.ceil((scrollTop + containerHeight) / rowHeight) - 1
    const startIndex = Math.max(0, visibleStart - OVERSCAN)
    const endIndex = Math.min(itemCount - 1, visibleEnd + OVERSCAN)

    return { containerRef, onScroll, totalHeight, startIndex, endIndex }
}
