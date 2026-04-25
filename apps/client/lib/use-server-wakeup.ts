'use client'

import { useState, useEffect } from 'react'
import { API_URL } from './api'

export type WakeupStatus =
    | 'idle'    // initial ping in flight — banner not shown yet
    | 'waking'  // server didn't respond in time — banner visible
    | 'awake'   // server is up — show brief confirmation then dismiss

/** Per-request timeout for each health ping (initial and polling). */
const PING_TIMEOUT_MS = 3_000

/** How often to retry while the server is waking up. */
const POLL_INTERVAL_MS = 5_000

/**
 * DEV ONLY — set to true to force the waking state immediately, bypassing the real
 * health ping. Lets you preview the full banner → recovery flow without waiting for
 * Render to actually sleep. Flip back to false before committing.
 */
const DEV_SIMULATE_SLEEP = false

async function pingHealth(timeoutMs: number): Promise<boolean> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
        const res = await fetch(`${API_URL}/health`, {
            signal: ac.signal,
            cache: 'no-store',
        })
        return res.ok
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Pings /health on mount. If the server doesn't respond within PING_TIMEOUT_MS,
 * transitions to 'waking' and polls every POLL_INTERVAL_MS until it comes back up.
 *
 * Returns:
 *  - status     — current wakeup phase
 *  - elapsedSec — seconds spent waiting (shown in the banner)
 */
export function useServerWakeup() {
    const [status, setStatus] = useState<WakeupStatus>('idle')
    const [elapsedSec, setElapsedSec] = useState(0)

    useEffect(() => {
        let cancelled = false
        let pollTimer: ReturnType<typeof setTimeout> | null = null
        let elapsedTimer: ReturnType<typeof setInterval> | null = null

        const stopTimers = () => {
            if (pollTimer) clearTimeout(pollTimer)
            if (elapsedTimer) clearInterval(elapsedTimer)
        }

        const startElapsedCounter = () => {
            const startTime = Date.now()
            elapsedTimer = setInterval(() => {
                if (!cancelled) setElapsedSec(Math.floor((Date.now() - startTime) / 1000))
            }, 1_000)
        }

        const poll = async () => {
            // When simulating, never resolve to awake — keeps the banner visible
            // indefinitely so you can inspect it without it flashing and disappearing.
            const isUp = DEV_SIMULATE_SLEEP ? false : await pingHealth(PING_TIMEOUT_MS)
            if (cancelled) return
            if (isUp) {
                stopTimers()
                setStatus('awake')
            } else {
                pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
            }
        }

        const run = async () => {
            // In dev, skip the real ping and jump straight to the waking state so you
            // can preview the banner → recovery flow without waiting for Render to sleep.
            const isUp = DEV_SIMULATE_SLEEP ? false : await pingHealth(PING_TIMEOUT_MS)
            if (cancelled) return

            if (isUp) {
                // Server was already awake — leave status as 'idle' so the banner
                // never renders. Only show the green confirmation when the server
                // recovers from a sleeping state (idle → waking → awake).
                return
            }

            // Server is sleeping — show the banner and start counting
            setStatus('waking')
            startElapsedCounter()
            pollTimer = setTimeout(poll, POLL_INTERVAL_MS)
        }

        run()

        return () => {
            cancelled = true
            stopTimers()
        }
    }, [])

    return { status, elapsedSec }
}
