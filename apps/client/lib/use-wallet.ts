import { useWalletContext } from '@/context/wallet-context'
import type { WalletContextValue } from '@/context/wallet-context'

export type UseWallet = WalletContextValue

/**
 * Hook to access the shared wallet state and actions.
 * Delegates to the root WalletContext so all components share the same balance cache.
 */
export function useWallet(_token?: string): UseWallet {
    void _token
    return useWalletContext()
}


