import { describe, it, expect } from 'vitest'
import { formatCredits, CREDIT_SCALE } from './format-credits'

describe('formatCredits', () => {
    it('uses 100 hundredths per credit', () => {
        expect(CREDIT_SCALE).toBe(100)
    })

    it('converts hundredths to credits with up to 2 decimals', () => {
        expect(formatCredits(4885)).toBe('48.85')
        expect(formatCredits(97)).toBe('0.97')
        expect(formatCredits(3)).toBe('0.03')
        expect(formatCredits(0)).toBe('0')
    })

    it('trims trailing zeros', () => {
        expect(formatCredits(500)).toBe('5')
        expect(formatCredits(4880)).toBe('48.8')
        expect(formatCredits(100)).toBe('1')
    })

    it('handles negative (consumption) amounts', () => {
        expect(formatCredits(-100)).toBe('-1')
        expect(formatCredits(-3)).toBe('-0.03')
    })
})
