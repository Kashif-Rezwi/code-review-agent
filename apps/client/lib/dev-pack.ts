'use client'

import { useSearchParams } from 'next/navigation'

export const DEV_PACK_PARAM = 'dev_pack'

/**
 * Reads the operator-only dev-pack secret from the current page URL
 * (/account?dev_pack=<secret>). The value is forwarded to the API as the
 * x-dev-pack header — the server activates the hidden ₹1 pack only when it
 * matches its PAYMENTS_DEV_PACK env secret. The secret itself must never be
 * committed or documented anywhere.
 */
export function useDevPackSecret(): string | null {
    const searchParams = useSearchParams()
    return searchParams.get(DEV_PACK_PARAM)
}
