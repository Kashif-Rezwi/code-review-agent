// Credit package definitions and operation costs — server-side only, never exposed to client.

export interface CreditPackage {
    credits: number
    amountPaise: number
    currency: string
    label: string
}

export const CREDIT_PACKAGES: Record<string, CreditPackage> = {
    '50': { credits: 50, amountPaise: 9_900, currency: 'INR', label: '50 Credits — ₹99' },
    '200': { credits: 200, amountPaise: 34_900, currency: 'INR', label: '200 Credits — ₹349' },
    '500': { credits: 500, amountPaise: 79_900, currency: 'INR', label: '500 Credits — ₹799' },
}

/**
 * Hidden ₹1 package for cheap live-mode smoke testing — active only when the
 * request presents the x-dev-pack header matching the operator-held
 * PAYMENTS_DEV_PACK env secret. Exists so the go-live payment flow
 * (order → webhook → credit grant) can be verified with ₹1 instead of the ₹99
 * minimum public pack. Real users never see it without the secret.
 */
export const DEV_PACK_PACKAGE_ID = 'dev1'
export const DEV_CREDIT_PACKAGE: CreditPackage = {
    credits: 1,
    amountPaise: 100,
    currency: 'INR',
    label: '1 Credit — ₹1 (dev)',
}

/**
 * Returns the packages available for purchase. The dev pack is included only when
 * explicitly enabled via PAYMENTS_DEV_PACK; the public surface stays limited to
 * CREDIT_PACKAGES otherwise.
 */
export function getActiveCreditPackages(devPackEnabled: boolean): Record<string, CreditPackage> {
    return devPackEnabled
        ? { ...CREDIT_PACKAGES, [DEV_PACK_PACKAGE_ID]: DEV_CREDIT_PACKAGE }
        : CREDIT_PACKAGES
}

/** Credit cost per operation. Resolved server-side — never trust client-supplied values. */
export const CREDIT_COSTS = {
    CODE_REVIEW: 5,  // single-agent, one LLM call
    PR_REVIEW: 10,   // multi-agent: N cluster workers + synthesis
    CHAT: 1,         // single fast-model call
} as const

/** Free credits granted once per user on first signup. */
export const FREE_CREDIT_AMOUNT = 25

/** TTL for pending CREATED orders before they are marked EXPIRED (30 minutes). */
export const ORDER_EXPIRY_MS = 30 * 60 * 1000

/** Returns the credit cost for a review type. Throws if type is unrecognised (implementation bug, not 402). */
export function getReviewCreditCost(type: 'CODE' | 'PR'): number {
    if (type === 'CODE') return CREDIT_COSTS.CODE_REVIEW
    if (type === 'PR') return CREDIT_COSTS.PR_REVIEW
    // Exhaustive — reaching this is a caller bug, not a user error.
    throw new Error(`Unknown review type: ${String(type)}`)
}

