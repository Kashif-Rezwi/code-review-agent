import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * Manages "copied!" flash state for clipboard copy buttons.
 * Returns `copied` (boolean) and `copy(text)` — the flag resets after `timeoutMs`.
 * The pending timer is cancelled automatically when the component unmounts.
 */
export function useCopyToClipboard(timeoutMs = 2000) {
    const [copied, setCopied] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        return () => { if (timerRef.current) clearTimeout(timerRef.current) }
    }, [])

    const copy = useCallback(async (text: string) => {
        await navigator.clipboard.writeText(text)
        if (timerRef.current) clearTimeout(timerRef.current)
        setCopied(true)
        timerRef.current = setTimeout(() => setCopied(false), timeoutMs)
    }, [timeoutMs])

    return { copied, copy }
}
