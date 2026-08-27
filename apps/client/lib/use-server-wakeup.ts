'use client'

import { useServerStatus } from 'server-active-indicator/react'

/**
 * @deprecated — legacy wrapper kept for backwards compatibility.
 * New code should use `useServerStatus()` from `server-active-indicator/react`
 * directly. This shim maps the package's 5-state snapshot to the old 3-state
 * API (`idle | waking | awake`) so any stray import doesn't break.
 *
 * Mapping:
 *  - unknown/checking/active(!wasCold) → idle  (silent)
 *  - waking/offline                  → waking (show banner + timer)
 *  - active && wasCold              → awake  (show green confirmation)
 */
export type WakeupStatus = 'idle' | 'waking' | 'awake'

export function useServerWakeup(): { status: WakeupStatus; elapsedSec: number } {
    const { status, elapsedSeconds, wasCold } = useServerStatus()

    let mapped: WakeupStatus = 'idle'
    if (status === 'waking' || status === 'offline') mapped = 'waking'
    else if (status === 'active' && wasCold) mapped = 'awake'
    else mapped = 'idle'

    return { status: mapped, elapsedSec: elapsedSeconds }
}
