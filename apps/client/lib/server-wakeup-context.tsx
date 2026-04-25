'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { useServerWakeup, type WakeupStatus } from './use-server-wakeup'

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

export function ServerWakeupProvider({ children }: { children: React.ReactNode }) {
    const { status, elapsedSec } = useServerWakeup()
    const [dismissed, setDismissed] = useState(false)

    useEffect(() => {
        if (status !== 'awake' || dismissed) return
        const t = setTimeout(() => setDismissed(true), 2_500)
        return () => clearTimeout(t)
    }, [status, dismissed])

    return (
        <WakeupContext.Provider value={{ status, elapsedSec, dismissed }}>
            {children}
        </WakeupContext.Provider>
    )
}
