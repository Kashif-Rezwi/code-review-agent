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
    score: z.coerce.number().min(1).max(10).transform(n => Math.round(n)),
    issues: z.array(ReviewIssueSchema),
    positives: z.array(z.string()),
    // Populated server-side after RAG retrieval — never emitted by the LLM.
    appliedStandards: z.array(z.string()).optional(),
    // Populated server-side after DB save — never emitted by the LLM.
    id: z.string().optional(),
})

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>
export type ReviewData = z.infer<typeof ReviewDataSchema>

/**
 * Events emitted by the /review/[analyze|from-pr]/stream SSE endpoints.
 * Each event is a JSON object on a `data:` line, delimited by \n\n.
 */
export type ReviewStreamEvent =
    | { type: 'start' }
    | { type: 'thinking'; text: string }
    | { type: 'task_plan'; tasks: { id: string; label: string }[] }
    | { type: 'task_update'; taskId: string; status: 'running' | 'done'; detail?: string }
    | { type: 'tool_start'; tool: string; label: string; callId: string; detail?: string }
    | { type: 'tool_done'; callId: string; label: string; detail?: string; durationMs: number }
    | { type: 'complete'; review: ReviewData; durationMs: number; stepCount: number }
    | { type: 'error'; message: string }