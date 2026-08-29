'use client'

/* eslint-disable react-hooks/set-state-in-effect -- intentional cascading render, mirrors <ServerStatus> default UI */
import { useEffect, useRef, useState } from 'react'
import { CloudOff, CheckCircle, Loader2, WifiOff, CircleX } from 'lucide-react'
import { useServerStatus } from 'server-active-indicator/react'
import { cn } from '@/lib/utils'

function formatElapsed(sec: number): string {
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/**
 * Inline strip in AppHeader: silent when warm, amber "waking" banner with a live
 * timer, brief green confirmation after recovery, red offline banner with Retry.
 * Reads the shared monitor from `ServerStatusProvider` (root layout) via the
 * package's headless hook, keeping the app's own Tailwind styling.
 */
export function ServerWakeupBanner() {
    const { status, elapsedSeconds, wasCold, offlineKind, refresh } = useServerStatus()

    const [dismissed, setDismissed] = useState(true)
    const hasSeenWakeOrOfflineRef = useRef(false)

    useEffect(() => {
        if (status === 'waking' || status === 'offline') {
            hasSeenWakeOrOfflineRef.current = true
            setDismissed(false)
        }
    }, [status])

    useEffect(() => {
        if (status !== 'active' || !wasCold || dismissed) return
        if (!hasSeenWakeOrOfflineRef.current) return
        const t = setTimeout(() => setDismissed(true), 2_500)
        return () => clearTimeout(t)
    }, [status, wasCold, dismissed])

    if (status === 'unknown' || status === 'checking') return null
    if (status === 'active' && (!wasCold || dismissed)) return null

    const isWaking = status === 'waking'
    const isActive = status === 'active'
    const isOffline = status === 'offline'
    const isBrowserOffline = isOffline && offlineKind === 'browser'

    return (
        <div
            role="status"
            aria-live="polite"
            data-state={status}
            data-offline-kind={offlineKind}
            className={cn(
                'w-full flex items-center justify-center gap-2.5',
                'px-4 py-2 text-xs font-medium',
                'border-b transition-colors duration-500',
                isWaking
                    ? 'bg-amber-950/60 border-amber-500/20 text-amber-300'
                    : isActive
                      ? 'bg-green-950/60 border-green-500/20 text-green-300'
                      : 'bg-red-950/60 border-red-500/20 text-red-300',
            )}
        >
            {isWaking ? (
                <>
                    <CloudOff className="w-3.5 h-3.5 shrink-0 text-amber-400" aria-hidden />
                    <span>Server is waking up</span>
                    <span className="flex items-center gap-1.5 pl-2.5 border-l border-amber-500/25 text-amber-400/70 tabular-nums">
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
                        {formatElapsed(elapsedSeconds)}
                    </span>
                </>
            ) : isActive ? (
                <>
                    <CheckCircle className="w-3.5 h-3.5 shrink-0 text-green-400" aria-hidden />
                    <span>Server is ready</span>
                </>
            ) : isBrowserOffline ? (
                <>
                    <WifiOff className="w-3.5 h-3.5 shrink-0 text-red-400" aria-hidden />
                    <span>You appear to be offline — check your connection.</span>
                    <button
                        type="button"
                        onClick={refresh}
                        className="ml-2 inline-flex items-center rounded-md border border-current px-2.5 py-0.5 text-xs font-semibold hover:bg-current/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current cursor-pointer"
                    >
                        Retry
                    </button>
                </>
            ) : (
                <>
                    <CircleX className="w-3.5 h-3.5 shrink-0 text-red-400" aria-hidden />
                    <span>The server appears to be unavailable.</span>
                    <button
                        type="button"
                        onClick={refresh}
                        className="ml-2 inline-flex items-center rounded-md border border-current px-2.5 py-0.5 text-xs font-semibold hover:bg-current/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current cursor-pointer"
                    >
                        Retry
                    </button>
                </>
            )}
        </div>
    )
}
