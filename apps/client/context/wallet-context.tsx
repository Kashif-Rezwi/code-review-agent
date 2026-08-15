'use client'

import React, { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { paymentsService } from '@/lib/api'
import type { CreditPackage, LedgerEntry, WalletResponse } from '@cra/types'

export interface WalletContextValue {
    balance: number
    ledger: LedgerEntry[]
    packages: CreditPackage[]
    isLoading: boolean
    isPolling: boolean
    error: string | null
    refresh: () => Promise<void>
    startPolling: (targetOrderId?: string) => void
    stopPolling: () => void
}

const POLLING_INTERVAL_MS = 2000
const MAX_POLLING_ATTEMPTS = 25

const WalletContext = createContext<WalletContextValue | null>(null)

export function WalletProvider({ children }: { children: React.ReactNode }) {
    const { data: session } = useSession()
    const token = session?.githubToken

    const [balance, setBalance] = useState<number>(0)
    const [ledger, setLedger] = useState<LedgerEntry[]>([])
    const [packages, setPackages] = useState<CreditPackage[]>([])
    const [isLoading, setIsLoading] = useState<boolean>(true)
    const [isPolling, setIsPolling] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)

    const initialBalanceRef = useRef<number | null>(null)
    const pollingAttemptsRef = useRef<number>(0)
    const pollingTimerRef = useRef<NodeJS.Timeout | null>(null)
    const targetOrderIdRef = useRef<string | null>(null)

    const fetchWallet = useCallback(async () => {
        if (!token) {
            setIsLoading(false)
            return
        }
        try {
            const data = await paymentsService.getWallet<WalletResponse>(token)
            setBalance(data.balance)
            setLedger(data.ledger)
            setPackages(data.packages)
            setError(null)
            return data
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch wallet data.')
        } finally {
            setIsLoading(false)
        }
    }, [token])

    useEffect(() => {
        if (token) {
            void fetchWallet()
        } else {
            setIsLoading(false)
        }
    }, [token, fetchWallet])

    const stopPolling = useCallback(() => {
        if (pollingTimerRef.current) {
            clearInterval(pollingTimerRef.current)
            pollingTimerRef.current = null
        }
        targetOrderIdRef.current = null
        setIsPolling(false)
        pollingAttemptsRef.current = 0
    }, [])

    const startPolling = useCallback((targetOrderId?: string) => {
        stopPolling()
        initialBalanceRef.current = balance
        targetOrderIdRef.current = targetOrderId ?? null
        pollingAttemptsRef.current = 0
        setIsPolling(true)

        pollingTimerRef.current = setInterval(async () => {
            pollingAttemptsRef.current += 1

            try {
                const data = await fetchWallet()
                if (data) {
                    // RZC-006 / ADR-005: Precise ledger entry matching for target order ID
                    const foundTargetOrder = targetOrderIdRef.current
                        ? data.ledger.some((e) => e.orderId === targetOrderIdRef.current)
                        : false

                    const balanceIncreased =
                        initialBalanceRef.current !== null && data.balance > initialBalanceRef.current

                    if (foundTargetOrder || (!targetOrderIdRef.current && balanceIncreased)) {
                        stopPolling()
                        return
                    }
                }
            } catch {
                // Ignore transient network errors while polling
            }

            if (pollingAttemptsRef.current >= MAX_POLLING_ATTEMPTS) {
                stopPolling()
            }
        }, POLLING_INTERVAL_MS)
    }, [balance, fetchWallet, stopPolling])

    useEffect(() => {
        return () => {
            if (pollingTimerRef.current) {
                clearInterval(pollingTimerRef.current)
            }
        }
    }, [])

    const value: WalletContextValue = {
        balance,
        ledger,
        packages,
        isLoading,
        isPolling,
        error,
        refresh: async () => {
            await fetchWallet()
        },
        startPolling,
        stopPolling,
    }

    return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWalletContext(): WalletContextValue {
    const context = useContext(WalletContext)
    if (!context) {
        throw new Error('useWalletContext must be used within a WalletProvider')
    }
    return context
}
