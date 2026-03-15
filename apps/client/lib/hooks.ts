import { useState } from 'react'

/**
 * Manages "copied!" flash state for clipboard copy buttons.
 * Returns `copied` (boolean) and `copy(text)` — the flag resets after `timeoutMs`.
 */
export function useCopyToClipboard(timeoutMs = 2000) {
    const [copied, setCopied] = useState(false)

    const copy = async (text: string) => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), timeoutMs)
    }

    return { copied, copy }
}
