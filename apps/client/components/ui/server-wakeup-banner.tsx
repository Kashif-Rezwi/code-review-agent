'use client'

import { CloudOff, CheckCircle, Loader2 } from 'lucide-react'
import { useWakeupContext } from '@/lib/server-wakeup-context'
import { cn } from '@/lib/utils'

function formatElapsed(sec: number): string {
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/**
 * Inline strip inside AppHeader shown only when the Render free-tier server is sleeping — the first
 * health ping has a 3s timeout before revealing, so awake servers produce zero visual noise. State lives
 * in ServerWakeupProvider (root layout) so the timer/dismissed flag survive page navigations.
 */
export function ServerWakeupBanner() {
    const { status, elapsedSec, dismissed } = useWakeupContext()

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
                'border-b transition-colors duration-500',
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
