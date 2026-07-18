import { z } from 'zod'

export const ReviewIssueSchema = z.object({
    type: z.enum(['bug', 'security', 'performance', 'style', 'suggestion']),
    severity: z.enum(['critical', 'warning', 'info']),
    title: z.string(),
    location: z.string(),
    description: z.string(),
    recommendation: z.string(),
})

export const ReviewAcquisitionSourceSchema = z.enum(['github_files_api', 'public_diff'])

export const ReviewCoverageSchema = z.object({
    totalFiles: z.number().int().nonnegative(),
    assignedFiles: z.number().int().nonnegative(),
    reviewedFiles: z.number().int().nonnegative(),
    truncatedFiles: z.array(z.string()),
    metadataOnlyFiles: z.array(z.string()),
    unreviewedFiles: z.array(z.string()),
    failedClusters: z.array(z.string()),
    acquisitionSource: ReviewAcquisitionSourceSchema,
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
    // Populated server-side for PR reviews. Optional for historical reviews.
    coverage: ReviewCoverageSchema.optional(),
})

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>
export type ReviewData = z.infer<typeof ReviewDataSchema>
export type ReviewCoverage = z.infer<typeof ReviewCoverageSchema>
export type ReviewAcquisitionSource = z.infer<typeof ReviewAcquisitionSourceSchema>

/**
 * Events emitted by the /review/[analyze|from-pr]/stream SSE endpoints.
 * Each event is a JSON object on a `data:` line, delimited by \n\n.
 *
 * `clusterId` is present only when running the multi-agent clustered PR path.
 * All single-agent paths leave it undefined, preserving backward compatibility.
 */
export type ReviewStreamEvent =
    | { type: 'start' }
    | {
        type: 'acquisition'
        source: ReviewAcquisitionSource
        fileCount: number
        complete: boolean
        warnings: string[]
      }
    | { type: 'thinking'; clusterId?: string; text: string }
    | { type: 'task_plan'; tasks: { id: string; label: string }[] }
    | { type: 'task_update'; taskId: string; status: 'running' | 'done'; detail?: string }
    | { type: 'tool_start'; clusterId?: string; tool: string; label: string; callId: string; detail?: string }
    | { type: 'tool_done'; clusterId?: string; callId: string; label: string; detail?: string; durationMs: number }
    | {
        type: 'complete'
        review: ReviewData
        durationMs: number
        stepCount: number
        outcome?: 'complete' | 'partial'
      }
    | { type: 'error'; message: string }
    | {
        type: 'cluster_plan'
        clusters: {
            id: string
            label: string
            focus: string
            files: {
                name: string
                additions: number
                deletions: number
                status: string
                patchState?: 'full' | 'truncated' | 'metadata_only' | 'binary'
            }[]
        }[]
      }
    | { type: 'cluster_done'; clusterId: string; issueCount: number; durationMs: number; attempts?: number }
    | { type: 'cluster_failed'; clusterId: string; attempts: number; message: string; durationMs: number }
    | { type: 'synthesis_start'; clusterCount: number }
