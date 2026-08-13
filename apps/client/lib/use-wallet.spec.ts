import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useWallet } from './use-wallet'
import { paymentsService } from './api'

vi.mock('./api', () => ({
    paymentsService: {
        getWallet: vi.fn(),
        createOrder: vi.fn(),
    },
}))

describe('useWallet', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('fetches wallet data on mount when githubToken is present', async () => {
        const mockWallet = {
            balance: 100,
            ledger: [{ id: '1', type: 'PURCHASE', amount: 100, balanceAfter: 100, description: 'Test', createdAt: '2026-08-13T00:00:00Z' }],
            packages: [{ id: '50', label: '50 Credits', credits: 50, amountPaise: 9900, currency: 'INR' }],
        }
        vi.mocked(paymentsService.getWallet).mockResolvedValue(mockWallet)

        const { result } = renderHook(() => useWallet('token-123'))

        await waitFor(() => expect(result.current.isLoading).toBe(false))

        expect(result.current.balance).toBe(100)
        expect(result.current.ledger).toEqual(mockWallet.ledger)
        expect(result.current.packages).toEqual(mockWallet.packages)
    })

    it('startPolling triggers polling mode and stopPolling halts it', async () => {
        const mockWallet = { balance: 50, ledger: [], packages: [] }
        vi.mocked(paymentsService.getWallet).mockResolvedValue(mockWallet)

        const { result } = renderHook(() => useWallet('token-123'))

        await waitFor(() => expect(result.current.isLoading).toBe(false))

        act(() => {
            result.current.startPolling()
        })

        expect(result.current.isPolling).toBe(true)

        act(() => {
            result.current.stopPolling()
        })

        expect(result.current.isPolling).toBe(false)
    })
})
