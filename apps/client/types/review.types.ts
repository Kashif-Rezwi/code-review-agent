// Pure type re-exports from the shared contract package — do NOT add runtime values
// here; they belong in review-config.ts so type-only imports stay side-effect-free.

export type { ReviewIssue, ReviewData, ReviewStreamEvent } from '@cra/types'

/** A single chat turn: user question or assistant reply. Shared by ChatThread + history pages. */
export interface ChatMessage {
    role: 'user' | 'assistant'
    content: string
}
