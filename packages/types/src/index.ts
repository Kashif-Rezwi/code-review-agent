import { z } from 'zod'

export const ReviewIssueSchema = z.object({
    type: z.enum(['bug', 'security', 'performance', 'style', 'suggestion']),
    severity: z.enum(['critical', 'warning', 'info']),
    title: z.string().max(200),
    location: z.string().max(500),
    description: z.string().max(4_000),
    recommendation: z.string().max(4_000),
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
    summary: z.string().max(2_000),
    score: z.coerce.number().min(1).max(10).transform(n => Math.round(n)),
    issues: z.array(ReviewIssueSchema).max(100),
    positives: z.array(z.string().max(1_000)).max(50),
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
 * Events emitted by the GET /review/:id/stream SSE endpoint (one JSON object per `data:` line).
 * `clusterId` is present only on the multi-agent clustered PR path; single-agent paths leave it undefined.
 */
export type ReviewStreamEvent =
    | { type: 'start' }
    | { type: 'heartbeat' }
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

// ── Payment / Credit Wallet ──────────────────────────────────────────────────

export const CreditPackageSchema = z.object({
    id: z.string(),
    label: z.string(),
    credits: z.number().int().positive(),
    amountPaise: z.number().int().positive(),
    currency: z.string(),
})

export const LedgerEntrySchema = z.object({
    id: z.string(),
    type: z.enum(['FREE_GRANT', 'PURCHASE', 'CONSUMPTION', 'CONSUMPTION_REFUND', 'SETTLEMENT']),
    // All credit amounts are in HUNDREDTHS (100 = 1 credit = ₹1) — display divides by 100.
    amount: z.number().int(),
    balanceAfter: z.number().int().nonnegative(),
    orderId: z.string().nullable().optional(),
    reviewId: z.string().nullable().optional(),
    description: z.string().nullable(),
    createdAt: z.string(), // ISO 8601 string from JSON serialisation
})

export const WalletResponseSchema = z.object({
    balance: z.number().int().nonnegative(),
    ledger: z.array(LedgerEntrySchema),
    packages: z.array(CreditPackageSchema),
})

export type CreditPackage = z.infer<typeof CreditPackageSchema>
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>
export type WalletResponse = z.infer<typeof WalletResponseSchema>
