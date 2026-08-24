import {
    CREDIT_SCALE,
    RESERVES,
    creditsFromTopup,
    costFromUsage,
    getReviewReserve,
    FALLBACK_MODEL_PRICE,
} from './credit-cost.policy'

describe('credit-cost.policy', () => {
    describe('creditsFromTopup', () => {
        it('applies the Razorpay fee haircut at purchase time', () => {
            // floor(amountPaise / 1.0236)
            expect(creditsFromTopup(100)).toBe(97) // ₹1 dev pack
            expect(creditsFromTopup(500)).toBe(488) // ₹5
            expect(creditsFromTopup(1_000)).toBe(976) // ₹10
            expect(creditsFromTopup(5_000)).toBe(4884) // ₹50
        })

        it('always rounds down (never over-grants)', () => {
            for (const paise of [100, 101, 250, 999, 1_001, 12_345]) {
                expect(creditsFromTopup(paise)).toBeLessThanOrEqual(paise / 1.0236)
                expect(Number.isInteger(creditsFromTopup(paise))).toBe(true)
            }
        })
    })

    describe('costFromUsage', () => {
        it('prices real token consumption per model, ceiled to hundredths', () => {
            // deepseek-v4-flash-0731: $0.08 in / $0.15 out per 1M, ×84 ₹/$, ×1.2, ×100
            // (3000×0.08 + 500×0.15)/1e6 × 84 × 1.2 × 100 = 3.1752 → ceil = 4
            expect(
                costFromUsage('deepseek/deepseek-v4-flash-0731', { inputTokens: 3_000, outputTokens: 500 }),
            ).toBe(4)
        })

        it('bills an unknown model at the conservative fallback price', () => {
            const known = costFromUsage('meta/muse-spark-1.2-contributor', { inputTokens: 1_000, outputTokens: 1_000 })
            const unknown = costFromUsage('some/future-model', { inputTokens: 1_000, outputTokens: 1_000 })
            expect(unknown).toBe(known) // fallback == review-model price
            expect(FALLBACK_MODEL_PRICE).toEqual({ in: 0.10, out: 0.20 })
        })

        it('zero usage costs zero (caller refunds the full reserve)', () => {
            expect(costFromUsage('meta/muse-spark-1.2-contributor', { inputTokens: 0, outputTokens: 0 })).toBe(0)
        })

        it('never undercharges on fractional cost (ceil)', () => {
            // A tiny amount of usage still costs at least 1 hundredth.
            expect(
                costFromUsage('deepseek/deepseek-v4-flash-0731', { inputTokens: 1, outputTokens: 0 }),
            ).toBe(1)
        })
    })

    describe('reserves', () => {
        it('provides reserves for both review types', () => {
            expect(getReviewReserve('CODE')).toBe(RESERVES.CODE_REVIEW)
            expect(getReviewReserve('PR')).toBe(RESERVES.PR_REVIEW)
        })

        it('throws on an unrecognised type (caller bug, not 402)', () => {
            expect(() => getReviewReserve('NOPE' as 'CODE')).toThrow('Unknown review type')
        })

        it('reserves cover the realistic per-op cost so settlement always refunds down', () => {
            // A code review (~15k in / 3k out on the review model) must stay under its reserve.
            const codeCost = costFromUsage('meta/muse-spark-1.2-contributor', { inputTokens: 15_000, outputTokens: 3_000 })
            expect(codeCost).toBeLessThan(RESERVES.CODE_REVIEW)
            // A typical PR (3 workers + synthesis, ~60k/12k) stays under the PR reserve.
            const prCost = costFromUsage('meta/muse-spark-1.2-contributor', { inputTokens: 60_000, outputTokens: 12_000 })
            expect(prCost).toBeLessThan(RESERVES.PR_REVIEW)
        })
    })

    describe('scale', () => {
        it('uses 100 hundredths per credit', () => {
            expect(CREDIT_SCALE).toBe(100)
        })
    })

    describe('env overrides', () => {
        const ENV_KEYS = ['RAZORPAY_FEE_RATE', 'USD_INR', 'CREDIT_SAFETY_FACTOR'] as const
        const saved: Record<string, string | undefined> = {}

        beforeEach(() => {
            for (const k of ENV_KEYS) saved[k] = process.env[k]
        })
        afterEach(() => {
            for (const k of ENV_KEYS) {
                if (saved[k] === undefined) delete process.env[k]
                else process.env[k] = saved[k]
            }
        })

        it('honours a valid env override at call time (not import time)', () => {
            process.env.RAZORPAY_FEE_RATE = '0' // zero fee → full amount granted
            expect(creditsFromTopup(500)).toBe(500)
        })

        it('ignores a malformed env value instead of producing NaN', () => {
            process.env.RAZORPAY_FEE_RATE = 'not-a-number'
            process.env.USD_INR = 'garbage'
            process.env.CREDIT_SAFETY_FACTOR = 'NaN'
            // Falls back to defaults — same as the no-env case.
            expect(creditsFromTopup(500)).toBe(488)
            expect(Number.isFinite(creditsFromTopup(500))).toBe(true)
            expect(
                Number.isFinite(costFromUsage('meta/muse-spark-1.2-contributor', { inputTokens: 1000, outputTokens: 1000 })),
            ).toBe(true)
        })

        it('treats an empty-string override as unset', () => {
            process.env.USD_INR = ''
            expect(creditsFromTopup(500)).toBe(488)
        })
    })
})
