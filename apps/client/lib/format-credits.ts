/**
 * Credits are stored/transmitted in hundredths (100 = 1 credit = ₹1) so sub-credit
 * charges stay exact server-side. The display layer converts to whole/decimal credits.
 */

/** 100 hundredths = 1 credit. Kept in sync with the server's CREDIT_SCALE. */
export const CREDIT_SCALE = 100

/** Format hundredths as credits with up to 2 decimals, trimming trailing zeros: 4885 → "48.85", 500 → "5", 30 → "0.3". */
export function formatCredits(hundredths: number): string {
    const credits = hundredths / CREDIT_SCALE
    // Round to 2 decimals to avoid float noise, then strip trailing zeros.
    return String(Number(credits.toFixed(2)))
}
