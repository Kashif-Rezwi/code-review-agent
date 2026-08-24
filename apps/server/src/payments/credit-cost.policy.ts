// Credit policy for cost-passthrough billing — server-side only, never exposed to client.
//
// Credit unit: 1 credit = ₹1 of inference value (fixed-value unit, OpenRouter-style).
// Credits are stored and computed in HUNDREDTHS (integer "credit-paise") so that
// sub-credit charges (a chat costs ~3 hundredths) stay exact and DB operations stay
// atomic integers. Display layer divides by CREDIT_SCALE.
//
// Money flow:
//   top-up  → creditsFromTopup(amountPaise)  — Razorpay fee (2% + 18% GST = 2.36%) is a
//              purchase-time haircut; usage itself is at-cost (no per-request markup).
//   usage   → costFromUsage(modelId, usage)  — real token consumption × gateway list
//              price × SAFETY_FACTOR. The 20% buffer absorbs gateway repricing, INR/USD
//              drift, embedding costs, and cancelled-work token spend.
//   reserve → each operation reserves a worst-case amount up-front (existing atomic
//              deduction), then settles the unused remainder on success.

/** Credits are stored in hundredths: 100 = 1 credit = ₹1. */
export const CREDIT_SCALE = 100

/**
 * Parse a numeric env override, falling back on the default when unset or unparseable.
 * Read lazily (per call) rather than at module scope: Nest's ConfigModule loads `.env`
 * into process.env during bootstrap, which runs AFTER module imports evaluate — a
 * module-scope read would silently miss `.env`-provided overrides. A NaN guard keeps a
 * malformed value from corrupting billing math.
 */
function envNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
}

/** Razorpay domestic fee 2% + 18% GST on the fee = 2.36% effective. Env-overridable. */
export function razorpayFeeRate(): number {
    return envNumber('RAZORPAY_FEE_RATE', 0.0236)
}

/** Static USD→INR rate for cost computation. Env-overridable; not live FX on purpose. */
export function usdInrRate(): number {
    return envNumber('USD_INR', 84)
}

/** Margin buffer over raw inference cost — covers repricing/FX drift/embeddings/cancelled work. */
export function safetyFactor(): number {
    return envNumber('CREDIT_SAFETY_FACTOR', 1.2)
}

export interface TokenUsage {
    inputTokens: number
    outputTokens: number
}

/**
 * Gateway list prices per 1M tokens (USD), from the Vercel AI Gateway model listing
 * (gateway charges zero markup). Keyed by model ID; update here if models rotate.
 */
export const MODEL_PRICES_PER_1M: Record<string, { in: number; out: number }> = {
    'meta/muse-spark-1.2-contributor': { in: 0.10, out: 0.20 },
    'deepseek/deepseek-v4-flash-0731': { in: 0.08, out: 0.15 },
}

/** Conservative default when a model ID isn't in the table — billed at the pricier review-model rate. */
export const FALLBACK_MODEL_PRICE = { in: 0.10, out: 0.20 }

/**
 * Up-front reservation per operation, in hundredths. Sized to the worst-case token cost
 * so a review can never start without being able to pay for its most expensive outcome;
 * the unused remainder is refunded on settlement.
 */
export const RESERVES = {
    CODE_REVIEW: 100, // 1.00 credit — actual ≈ 0.21
    PR_REVIEW: 500, //   5.00 credits — actual ≈ 0.84 (3 workers) to 2.82 (8 workers)
    CHAT: 10, //         0.10 credit — actual ≈ 0.03
} as const

/** Free credits granted once per user on first signup (hundredths). ₹5 — caps signup abuse. */
export const FREE_CREDIT_AMOUNT = 500

/** TTL for pending CREATED orders before they are marked EXPIRED (30 minutes). */
export const ORDER_EXPIRY_MS = 30 * 60 * 1000

/**
 * Credits granted for a top-up, in hundredths. The Razorpay fee is deducted here —
 * the user receives the net purchasing power of their payment.
 */
export function creditsFromTopup(amountPaise: number): number {
    return Math.floor(amountPaise / (1 + razorpayFeeRate()))
}

/**
 * Credits charged for a completed operation, in hundredths. Ceiled so we never undercharge.
 * Unknown model IDs bill at FALLBACK_MODEL_PRICE; missing usage bills nothing (caller refunds fully).
 */
export function costFromUsage(modelId: string, usage: TokenUsage): number {
    const price = MODEL_PRICES_PER_1M[modelId] ?? FALLBACK_MODEL_PRICE
    const costUsd = (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000
    return Math.ceil(costUsd * usdInrRate() * safetyFactor() * CREDIT_SCALE)
}

/** Up-front reserve for a review type (hundredths). Throws if type is unrecognised (implementation bug, not 402). */
export function getReviewReserve(type: 'CODE' | 'PR'): number {
    if (type === 'CODE') return RESERVES.CODE_REVIEW
    if (type === 'PR') return RESERVES.PR_REVIEW
    // Exhaustive — reaching this is a caller bug, not a user error.
    throw new Error(`Unknown review type: ${String(type)}`)
}

// ── Top-up packages ─────────────────────────────────────────────────────────

export interface CreditPackage {
    amountPaise: number
    currency: string
    label: string
}

export const CREDIT_PACKAGES: Record<string, CreditPackage> = {
    '5': { amountPaise: 500, currency: 'INR', label: '₹5 Top-up' },
    '10': { amountPaise: 1_000, currency: 'INR', label: '₹10 Top-up' },
    '50': { amountPaise: 5_000, currency: 'INR', label: '₹50 Top-up' },
}

/**
 * Hidden ₹1 package for cheap live-mode smoke testing — active only when the
 * request presents the x-dev-pack header matching the operator-held
 * PAYMENTS_DEV_PACK env secret. Exists so the go-live payment flow
 * (order → webhook → credit grant) can be verified with ₹1 instead of the ₹5
 * minimum public pack. Real users never see it without the secret.
 */
export const DEV_PACK_PACKAGE_ID = 'dev1'
export const DEV_CREDIT_PACKAGE: CreditPackage = {
    amountPaise: 100,
    currency: 'INR',
    label: '₹1 Top-up (dev)',
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

