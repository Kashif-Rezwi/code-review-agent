import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useWallet } from './use-wallet'
import { WalletProvider } from '@/context/wallet-context'
import { paymentsService } from './api'

vi.mock('next-auth/react', () => ({
    useSession: vi.fn(() => ({
        data: { githubToken: 'token-123' },
        status: 'authenticated',
    })),
}))

vi.mock('./api', () => ({
    paymentsService: {
        getWallet: vi.fn(),
        createOrder: vi.fn(),
    },
}))

const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(WalletProvider, null, children)


describe('useWallet', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('throws when used outside of WalletProvider', () => {
        expect(() => renderHook(() => useWallet())).toThrow(
            'useWalletContext must be used within a WalletProvider',
        )
    })

    it('fetches wallet data on mount when session is authenticated', async () => {
        const mockWallet = {
            balance: 100,
            ledger: [{ id: '1', type: 'PURCHASE', amount: 100, balanceAfter: 100, description: 'Test', createdAt: '2026-08-13T00:00:00Z' }],
            packages: [{ id: '50', label: '50 Credits', credits: 50, amountPaise: 9900, currency: 'INR' }],
        }
        vi.mocked(paymentsService.getWallet).mockResolvedValue(mockWallet)

        const { result } = renderHook(() => useWallet(), { wrapper })

        await waitFor(() => expect(result.current.isLoading).toBe(false))

        expect(result.current.balance).toBe(100)
        expect(result.current.ledger).toEqual(mockWallet.ledger)
        expect(result.current.packages).toEqual(mockWallet.packages)
    })

    it('refresh re-fetches wallet data on demand', async () => {
        const mockWallet = { balance: 50, ledger: [], packages: [] }
        vi.mocked(paymentsService.getWallet).mockResolvedValue(mockWallet)

        const { result } = renderHook(() => useWallet(), { wrapper })

        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.balance).toBe(50)
        const callsAfterMount = vi.mocked(paymentsService.getWallet).mock.calls.length

        const updatedWallet = { balance: 51, ledger: [], packages: [] }
        vi.mocked(paymentsService.getWallet).mockResolvedValue(updatedWallet)

        await act(async () => {
            await result.current.refresh()
        })

        expect(vi.mocked(paymentsService.getWallet).mock.calls.length).toBe(callsAfterMount + 1)
        expect(result.current.balance).toBe(51)
    })

    it('multiple hook consumers share the identical synchronized state container', async () => {
        const mockWallet = { balance: 75, ledger: [], packages: [] }
        vi.mocked(paymentsService.getWallet).mockResolvedValue(mockWallet)

        const { result: headerResult } = renderHook(() => useWallet(), { wrapper })
        const { result: pageResult } = renderHook(() => useWallet(), { wrapper })

        await waitFor(() => expect(headerResult.current.isLoading).toBe(false))
        expect(headerResult.current.balance).toBe(75)
        expect(pageResult.current.balance).toBe(75)
    })
})

