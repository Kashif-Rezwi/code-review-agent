import { z } from 'zod'

export const ReviewIssueSchema = z.object({
    type: z.enum(['bug', 'security', 'performance', 'style', 'suggestion']),
    severity: z.enum(['critical', 'warning', 'info']),
    title: z.string(),
    location: z.string(),
    description: z.string(),
    recommendation: z.string(),
})

export const ReviewDataSchema = z.object({
    summary: z.string(),
    score: z.number().int().min(1).max(10),
    issues: z.array(ReviewIssueSchema),
    positives: z.array(z.string()),
    // Populated server-side after RAG retrieval — never emitted by the LLM.
    appliedStandards: z.array(z.string()).optional(),
})

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>
export type ReviewData = z.infer<typeof ReviewDataSchema>