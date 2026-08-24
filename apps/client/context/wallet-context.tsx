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
    error: string | null
    refresh: () => Promise<void>
    enableDevPack: (secret: string) => void
}

const WalletContext = createContext<WalletContextValue | null>(null)

export function WalletProvider({ children }: { children: React.ReactNode }) {
    const { data: session } = useSession()
    const token = session?.githubToken

    const [balance, setBalance] = useState<number>(0)
    const [ledger, setLedger] = useState<LedgerEntry[]>([])
    const [packages, setPackages] = useState<CreditPackage[]>([])
    const [isLoading, setIsLoading] = useState<boolean>(true)
    const [error, setError] = useState<string | null>(null)

    // Set once via enableDevPack() from pages that accept the operator-only URL
    // param (e.g. /account?dev_pack=<secret>); forwarded as x-dev-pack on every
    // wallet fetch so the server can include the hidden ₹1 dev pack.
    const devPackRef = useRef<string | null>(null)

    const enableDevPack = useCallback((secret: string) => {
        devPackRef.current = secret
    }, [])

    const fetchWallet = useCallback(async () => {
        if (!token) {
            setIsLoading(false)
            return
        }
        try {
            const data = await paymentsService.getWallet<WalletResponse>(token, devPackRef.current ?? undefined)
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

    // Memoized — consumers use `refresh` in effect dependency arrays, so it must
    // keep a stable identity across renders or it causes an infinite fetch loop.
    const refresh = useCallback(async () => {
        await fetchWallet()
    }, [fetchWallet])

    const value: WalletContextValue = {
        balance,
        ledger,
        packages,
        isLoading,
        error,
        refresh,
        enableDevPack,
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
