'use client'

/* eslint-disable react-hooks/set-state-in-effect -- legacy shim mirrors package dismissal logic */
import { createContext, useContext, useEffect, useState, useRef } from 'react'
import { ServerStatusProvider as BaseProvider } from 'server-active-indicator/react'
import { useServerStatus } from 'server-active-indicator/react'
import { API_URL } from './api'
import type { WakeupStatus } from './use-server-wakeup'

interface WakeupContextValue {
    status: WakeupStatus
    elapsedSec: number
    dismissed: boolean
}

const WakeupContext = createContext<WakeupContextValue>({
    status: 'idle',
    elapsedSec: 0,
    dismissed: false,
})

export function useWakeupContext() {
    return useContext(WakeupContext)
}

/**
 * @deprecated — legacy provider kept for backwards compatibility.
 * New code should use `ServerStatusProvider` from `server-active-indicator/react`
 * directly (see `app/layout.tsx`). This wrapper preserves the old
 * `ServerWakeupProvider` import path by delegating to the package's provider
 * and re-exposing the old `{status, elapsedSec, dismissed}` shape via the
 * shimed `useServerStatus()` mapping.
 */
export function ServerWakeupProvider({ children }: { children: React.ReactNode }) {
    return (
        <BaseProvider healthUrl={`${API_URL.replace(/\/$/, '')}/health`}>
            <LegacyBridge>{children}</LegacyBridge>
        </BaseProvider>
    )
}

function LegacyBridge({ children }: { children: React.ReactNode }) {
    const { status, elapsedSeconds, wasCold } = useServerStatus()
    const [dismissed, setDismissed] = useState(true)
    const hasSeenWakeRef = useRef(false)

    const mapped: WakeupStatus =
        status === 'waking' || status === 'offline'
            ? 'waking'
            : status === 'active' && wasCold
              ? 'awake'
              : 'idle'

    useEffect(() => {
        if (mapped === 'waking') {
            hasSeenWakeRef.current = true
            setDismissed(false)
        }
    }, [mapped])

    useEffect(() => {
        if (mapped !== 'awake' || dismissed) return
        if (!hasSeenWakeRef.current) return
        const t = setTimeout(() => setDismissed(true), 2_500)
        return () => clearTimeout(t)
    }, [mapped, dismissed])

    // When still idle (warm) we keep dismissed true so the banner stays hidden
    const value: WakeupContextValue = {
        status: mapped,
        elapsedSec: elapsedSeconds,
        dismissed: mapped === 'awake' ? dismissed : mapped === 'idle' ? true : false,
    }

    return <WakeupContext.Provider value={value}>{children}</WakeupContext.Provider>
}
