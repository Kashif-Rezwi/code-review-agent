import { useCallback, useEffect, useRef, useState } from 'react'
import { paymentsService } from '@/lib/api'
import type { CreditPackage, LedgerEntry, WalletResponse } from '@cra/types'

interface UseWallet {
    balance: number
    ledger: LedgerEntry[]
    packages: CreditPackage[]
    isLoading: boolean
    isPolling: boolean
    error: string | null
    refresh: () => Promise<void>
    startPolling: () => void
    stopPolling: () => void
}

const POLLING_INTERVAL_MS = 2500
const MAX_POLLING_ATTEMPTS = 20

export function useWallet(githubToken?: string): UseWallet {
    const [balance, setBalance] = useState<number>(0)
    const [ledger, setLedger] = useState<LedgerEntry[]>([])
    const [packages, setPackages] = useState<CreditPackage[]>([])
    const [isLoading, setIsLoading] = useState<boolean>(true)
    const [isPolling, setIsPolling] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)

    const initialBalanceRef = useRef<number | null>(null)
    const pollingAttemptsRef = useRef<number>(0)
    const pollingTimerRef = useRef<NodeJS.Timeout | null>(null)

    const fetchWallet = useCallback(async () => {
        if (!githubToken) return
        try {
            const data = await paymentsService.getWallet<WalletResponse>(githubToken)
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
    }, [githubToken])

    useEffect(() => {
        void fetchWallet()
    }, [fetchWallet])

    const stopPolling = useCallback(() => {
        if (pollingTimerRef.current) {
            clearInterval(pollingTimerRef.current)
            pollingTimerRef.current = null
        }
        setIsPolling(false)
        pollingAttemptsRef.current = 0
    }, [])

    const startPolling = useCallback(() => {
        stopPolling()
        initialBalanceRef.current = balance
        pollingAttemptsRef.current = 0
        setIsPolling(true)

        pollingTimerRef.current = setInterval(async () => {
            pollingAttemptsRef.current += 1

            try {
                const data = await fetchWallet()
                if (data && initialBalanceRef.current !== null && data.balance > initialBalanceRef.current) {
                    stopPolling()
                    return
                }
            } catch {
                // Ignore transient polling errors
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

    return {
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
}
