import type { ReviewData } from '@/types/review.types'

// Parses the AI's raw text response into a structured ReviewData object. Strips markdown code fences.
export function parseReview(raw: string): ReviewData | null {
    if (!raw.trim()) return null
    try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
        return JSON.parse(cleaned) as ReviewData
    } catch {
        return null
    }
}
