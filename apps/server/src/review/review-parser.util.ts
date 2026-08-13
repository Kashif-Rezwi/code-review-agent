import { InternalServerErrorException } from '@nestjs/common'
import { ReviewDataSchema } from '@cra/ai'
import type { ReviewData } from '@cra/ai'

/**
 * Extract ReviewData from the model's text output.
 *
 * Handles five real-world failure modes in priority order:
 *   ① Clean JSON (most common — workers and synthesis under normal conditions)
 *   ② Markdown-fenced JSON  (``` json … ```)
 *   ③ Balanced-brace extraction from every line-boundary `{` — handles prose before JSON
 *      AND prose after JSON (the `lastIndexOf('}')` strategy breaks when the model
 *      appends trailing commentary containing `}` characters)
 *   ④ First `{` to matching balanced `}` — final safety net for inline JSON
 *
 * Throws only if all candidates fail Zod validation — the caller should then retry.
 */
export function parseReviewText(text: string): ReviewData {
    const t = text.trim()

    const candidates: string[] = [t]

    // ① Markdown fence — strip code fences the model adds despite instructions
    const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) candidates.push(fenceMatch[1].trim())

    // ② & ③ All line-boundary `{` positions (last to first) using balanced extraction.
    //   Processing last-to-first ensures we try the most recent JSON block first,
    //   which is correct when the model outputs analysis prose before the JSON object.
    const starts: number[] = []
    if (t.startsWith('{')) starts.push(0)
    let pos = 0
    while ((pos = t.indexOf('\n{', pos)) !== -1) { starts.push(pos + 1); pos++ }

    for (let i = starts.length - 1; i >= 0; i--) {
        const end = findBalancedBraceEnd(t, starts[i])
        if (end !== -1) candidates.push(t.slice(starts[i], end + 1))
    }

    // ④ First `{` to its balanced `}` — handles JSON not at a line boundary
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
 * Extract a review from an agent stream's settled output: the final text first,
 * then each step's text last-to-first (the most recent candidate is the most
 * likely real answer). Throws only when nothing parses — callers retry or fail.
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
 * Walk `text` from `start` (which must be `{`) to find its balanced closing `}`.
 * Correctly skips `{` and `}` characters inside JSON string values.
 * Returns the index of the closing `}`, or -1 if the braces are unbalanced.
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
