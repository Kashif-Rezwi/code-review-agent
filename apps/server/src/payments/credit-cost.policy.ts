// Credit package definitions and operation costs — server-side only, never exposed to client.

export const CREDIT_PACKAGES: Record<
    string,
    { credits: number; amountPaise: number; currency: string; label: string }
> = {
    '50': { credits: 50, amountPaise: 9_900, currency: 'INR', label: '50 Credits — ₹99' },
    '200': { credits: 200, amountPaise: 34_900, currency: 'INR', label: '200 Credits — ₹349' },
    '500': { credits: 500, amountPaise: 79_900, currency: 'INR', label: '500 Credits — ₹799' },
}

/** Credit cost per operation. Resolved server-side — never trust client-supplied values. */
export const CREDIT_COSTS = {
    CODE_REVIEW: 5,  // single-agent, one LLM call
    PR_REVIEW: 10,   // multi-agent: N cluster workers + synthesis
    CHAT: 1,         // single fast-model call
} as const

/** Free credits granted once per user on first signup. */
export const FREE_CREDIT_AMOUNT = 25

/** Returns the credit cost for a review type. Throws if type is unrecognised (implementation bug, not 402). */
export function getReviewCreditCost(type: 'CODE' | 'PR'): number {
    if (type === 'CODE') return CREDIT_COSTS.CODE_REVIEW
    if (type === 'PR') return CREDIT_COSTS.PR_REVIEW
    // Exhaustive — reaching this is a caller bug, not a user error.
    throw new Error(`Unknown review type: ${String(type)}`)
}
