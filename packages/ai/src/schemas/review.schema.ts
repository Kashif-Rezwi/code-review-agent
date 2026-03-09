import { z } from 'zod'

export const ReviewIssueSchema = z.object({
    id: z.string().describe('Unique identifier for this issue, e.g. "issue-1"'),
    type: z.enum(['bug', 'security', 'performance', 'style', 'suggestion']),
    severity: z.enum(['critical', 'warning', 'info']),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    title: z.string().max(60).describe('Short title, max 10 words'),
    explanation: z.string().describe('Clear explanation of WHY this is a problem'),
    suggestedFix: z.string().describe('Actual corrected code, not just a description'),
    codeExample: z.string().optional().describe('Full corrected code block if helpful'),
})

export const CodeReviewSchema = z.object({
    summary: z.string().describe('1-2 sentence summary of the code'),
    overallScore: z.number().int().min(1).max(10).describe('1 = do not ship, 10 = production ready'),
    issues: z.array(ReviewIssueSchema),
    positives: z.array(z.string()).describe('Things the code genuinely does well'),
})

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>
export type CodeReview = z.infer<typeof CodeReviewSchema>
