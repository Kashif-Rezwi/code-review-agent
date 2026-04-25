'use client'

import { useEffect, useState } from 'react'
import { CloudOff, CheckCircle, Loader2 } from 'lucide-react'
import { useServerWakeup } from '@/lib/use-server-wakeup'
import { cn } from '@/lib/utils'

function formatElapsed(sec: number): string {
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/**
 * Inline strip rendered inside AppHeader that appears only when the Render free-tier
 * server is sleeping. Shows nothing on fast connections — the first health ping has a
 * 3 s timeout before the banner is revealed, so awake servers produce zero visual noise.
 */
export function ServerWakeupBanner() {
    const { status, elapsedSec } = useServerWakeup()
    const [dismissed, setDismissed] = useState(false)

    // When the server comes back up, show the "ready" state briefly then auto-dismiss
    useEffect(() => {
        if (status !== 'awake' || dismissed) return
        const t = setTimeout(() => setDismissed(true), 2_500)
        return () => clearTimeout(t)
    }, [status, dismissed])

    // Never show if the server was already awake on first ping, or after dismissal
    if (dismissed || status === 'idle') return null

    const isWaking = status === 'waking'

    return (
        <div
            role="status"
            aria-live="polite"
            className={cn(
                'w-full flex items-center justify-center gap-2.5',
                'px-4 py-2 text-xs font-medium',
                'border-t transition-colors duration-500',
                isWaking
                    ? 'bg-amber-950/60 border-amber-500/20 text-amber-300'
                    : 'bg-green-950/60 border-green-500/20 text-green-300',
            )}
        >
            {isWaking ? (
                <>
                    <CloudOff className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                    <span>Server is waking up</span>
                    <span className="flex items-center gap-1.5 pl-2.5 border-l border-amber-500/25 text-amber-400/70 tabular-nums">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {formatElapsed(elapsedSec)}
                    </span>
                </>
            ) : (
                <>
                    <CheckCircle className="w-3.5 h-3.5 shrink-0 text-green-400" />
                    <span>Server is ready</span>
                </>
            )}
        </div>
    )
}
