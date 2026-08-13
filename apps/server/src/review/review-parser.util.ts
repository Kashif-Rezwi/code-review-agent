import { InternalServerErrorException } from '@nestjs/common'
import { ReviewDataSchema } from '@cra/ai'
import type { ReviewData } from '@cra/ai'

/**
 * Extract ReviewData from model output, trying in priority order: clean JSON, markdown-fenced JSON,
 * balanced-brace extraction from every line-boundary `{` (handles prose before/after the JSON — a
 * naive lastIndexOf('}') breaks on trailing commentary), and first `{` to its balanced `}`.
 * Throws only if every candidate fails Zod validation — the caller should then retry.
 */
export function parseReviewText(text: string): ReviewData {
    const t = text.trim()

    const candidates: string[] = [t]

    // Strip markdown fences the model adds despite instructions
    const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) candidates.push(fenceMatch[1].trim())

    // All line-boundary `{` positions, last-to-first — the most recent JSON block is
    // the likeliest answer when the model writes analysis prose before the JSON object.
    const starts: number[] = []
    if (t.startsWith('{')) starts.push(0)
    let pos = 0
    while ((pos = t.indexOf('\n{', pos)) !== -1) { starts.push(pos + 1); pos++ }

    for (let i = starts.length - 1; i >= 0; i--) {
        const end = findBalancedBraceEnd(t, starts[i])
        if (end !== -1) candidates.push(t.slice(starts[i], end + 1))
    }

    // First `{` to its balanced `}` — handles JSON not at a line boundary
    const firstBrace = t.indexOf('{')
    if (firstBrace !== -1) {
        const end = findBalancedBraceEnd(t, firstBrace)
        if (end !== -1) candidates.push(t.slice(firstBrace, end + 1))
    }

    for (const candidate of candidates) {
        try {
            return ReviewDataSchema.parse(JSON.parse(candidate))
        } catch { /* try next candidate */ }
    }

    throw new InternalServerErrorException(
        'The model did not return a valid review. Please try again.',
    )
}

/**
 * Extract a review from an agent stream's settled output: final text first, then each step's
 * text last-to-first (the most recent candidate is the likeliest answer). Throws only when nothing parses.
 */
export function parseReviewFromSteps(
    finalText: string,
    steps: ReadonlyArray<{ text: string }>,
): ReviewData {
    const candidates = [finalText, ...steps.map((step) => step.text).reverse()].filter((text) => text.trim())
    for (const text of candidates) {
        try {
            return parseReviewText(text)
        } catch { /* try next candidate */ }
    }
    throw new InternalServerErrorException('The model did not return a valid review. Please try again.')
}

/**
 * Walk `text` from `start` (which must be `{`) to its balanced closing `}`, skipping braces
 * inside JSON string values. Returns the closing index, or -1 if the braces are unbalanced.
 */
export function findBalancedBraceEnd(text: string, start: number): number {
    let depth = 0
    let inString = false
    let escape = false

    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (escape) { escape = false; continue }
        if (ch === '\\' && inString) { escape = true; continue }
        if (ch === '"') { inString = !inString; continue }
        if (inString) { continue }
        if (ch === '{') { depth++ }
        else if (ch === '}') { if (--depth === 0) return i }
    }
    return -1
}
