import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { generateText, streamText } from 'ai'
import { AiService } from '../ai/ai.service'
import {
    buildSystemPrompt,
    createRunLinterTool,
    planClusters,
    buildWorkerPrompt,
    buildSynthesisUserMessage,
    buildSynthesisSystemPrompt,
} from '@cra/ai'
import type { ReviewData, PRFile, ClusterPlan } from '@cra/ai'
import type { ReviewCoverage, ReviewStreamEvent } from '@cra/types'
import { GithubService } from '../github/github.service'
import { LinterService } from '../linter/linter.service'
import { RagService } from '../rag/rag.service'
import { ReviewRepository } from './review.repository'
import { QueueService } from '../queue/queue.service'
import { RedisService } from '../queue/redis.service'
import type { SseConnection } from './review.sse'
import { parseReviewText } from './review-parser.util'
import { parseArgs, pickArgs, toolStartLabel, toolStartDetail, toolDoneLabel, toolDoneDetail } from './review.formatter'
import { ThinkingStream } from './review.thinking'
import type { NormalizedPRFile, PRSnapshot } from '../github/github.types'

type MinimalAiStep = { text: string }
type MinimalStreamResult = {
    text: PromiseLike<string>
    steps: PromiseLike<MinimalAiStep[]>
}

// AI SDK overloads become extremely expensive for type-aware ESLint when a
// tool-rich call is inferred inline. These narrow adapters keep the SDK's
// runtime behavior while making the small response surface used here explicit.
const runStreamText = streamText as unknown as (options: Record<string, unknown>) => MinimalStreamResult
const runGenerateText = generateText as unknown as (
    options: Record<string, unknown>,
) => Promise<{ text: string }>
const buildLinterTool = createRunLinterTool as unknown as (
    execute: (input: { code: string; language: 'javascript' | 'typescript' }) => Promise<string>,
) => unknown

/** Maximum agent loop steps per review type. */
const AGENT_MAX_STEPS = { CODE: 10, WORKER: 5 } as const

/** Maximum diff characters forwarded to each worker agent per file.
 *  Keeps prompts within token budget while preserving most of the useful signal. */
const MAX_PATCH_CHARS = 8_000
const MAX_CLUSTER_PATCH_CHARS = 40_000
const WORKER_CONCURRENCY = 3
const WORKER_ATTEMPTS = 2

type StandardsContext = Awaited<ReturnType<RagService['retrieveForContext']>>

type WorkerSuccess = {
    status: 'fulfilled'
    cluster: ClusterPlan
    review: ReviewData
    attempts: number
    truncatedFiles: string[]
}

type WorkerFailure = {
    status: 'rejected'
    cluster: ClusterPlan
    error: unknown
}

type WorkerOutcome = WorkerSuccess | WorkerFailure

@Injectable()
export class ReviewService {
    private readonly logger = new Logger(ReviewService.name)
    constructor(
        private config: ConfigService,
        private reviewRepository: ReviewRepository,
        private githubService: GithubService,
        private linterService: LinterService,
        private ragService: RagService,
        private aiService: AiService,
        private queueService: QueueService,
        private redisService: RedisService,
    ) {}

    async createSession(type: 'CODE' | 'PR', input: string, userId: string) {
        const session = await this.reviewRepository.createSession(type, input, userId)
        if (!session) throw new InternalServerErrorException('Database not configured or failed to create session')
        await this.queueService.enqueue({
            reviewId: session.id,
            type: session.type as 'CODE' | 'PR',
            input: session.input,
            userId,
        })
        return session
    }

    async markFailed(reviewId: string, message: string, traceLog?: ReviewStreamEvent[]) {
        return this.reviewRepository.markFailed(reviewId, message, traceLog)
    }

    /**
     * Cancels an in-progress review:
     * 1. Removes the BullMQ job if it hasn't started yet.
     * 2. Marks the DB record as CANCELLED (no-op if already terminal).
     * 3. Emits a terminal error event to Redis so any live SSE client closes immediately.
     */
    async cancelReview(reviewId: string): Promise<void> {
        await this.queueService.removeJob(reviewId)
        const wasCancelled = await this.reviewRepository.markCancelled(reviewId)
        // Only push the terminal event when we actually flipped the status.
        // If the review already reached COMPLETE/FAILED, emitting an error event
        // here would corrupt the Redis replay list seen by future SSE connections.
        if (wasCancelled) {
            await this.redisService.emitEvent(reviewId, JSON.stringify({ type: 'error', message: 'Review cancelled' }))
        }
    }

    async runForQueue(
        reviewId: string,
        type: 'CODE' | 'PR',
        input: string,
        userId: string,
        conn: SseConnection,
    ): Promise<void> {
        try {
            if (type === 'PR') {
                this.githubService.assertValidPRUrl(input)
                await this.streamAnalyzeFromPR(input, userId, conn, reviewId)
            } else {
                await this.streamAnalyzeCode(input, userId, conn, reviewId)
            }
        } catch (err) {
            const message = this.publicErrorMessage(err)
            const event = { type: 'error' as const, message }
            const transitioned = await this.markFailed(reviewId, message, [...conn.getTrace(), event])
            // A cancelled or already-terminal review must not receive a second,
            // contradictory terminal event.
            if (transitioned) conn.send(event)
        }
    }

    // ── BullMQ Background Streaming ───────────────────────────────────────────
    // These orchestrate the pipeline and emit events directly to the Redis connection.

    async streamAnalyzeCode(code: string, userId: string, conn: SseConnection, reviewId?: string): Promise<void> {
        const standards = await this.ragService.retrieveForContext(code, userId)
        return this.streamAnalysis(
            `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
            standards,
            code,
            'CODE',
            userId,
            conn,
            reviewId,
        )
    }

    async streamAnalyzeFromPR(prUrl: string, userId: string, conn: SseConnection, reviewId?: string): Promise<void> {
        this.githubService.assertValidPRUrl(prUrl)

        const { send, startedAt } = conn
        send({ type: 'start' as const })

        // Acquisition and RAG are independent. Every acquisition source returns
        // normalized per-file context and therefore enters the same orchestrator.
        const [standards, snapshot] = await Promise.all([
            this.ragService.retrieveForContext('code review standards best practices', userId),
            this.githubService.fetchPRSnapshot(prUrl),
        ])
        const files = snapshot.files
        if (files.length === 0) throw new InternalServerErrorException('No reviewable pull-request files were acquired.')

        send({
            type: 'acquisition',
            source: snapshot.source,
            fileCount: files.length,
            complete: snapshot.complete,
            warnings: snapshot.warnings,
        })

        send({
            type: 'task_plan' as const,
            tasks: files.map((f) => ({
                id: f.filename,
                label: f.filename,
            })),
        })
        for (const f of files) {
            const diffLines = f.patch ? f.patch.split('\n').length : 0
            const context = f.patchState === 'full' ? '' : ` · ${f.patchState.replace('_', ' ')}`
            const detail = diffLines > 0
                ? `+${f.additions} -${f.deletions} · ${diffLines} diff lines${context}`
                : `${f.status}${context}`
            send({
                type: 'task_update' as const,
                taskId: f.filename,
                status: 'done',
                detail,
            })
        }

        const clusters = await planClusters(files, this.aiService.defaultModel)

        send({
            type: 'cluster_plan' as const,
            clusters: clusters.map((c) => ({
                id: c.id,
                label: c.label,
                focus: c.focus,
                files: c.files.map((f) => ({
                    name: f.filename,
                    additions: f.additions,
                    deletions: f.deletions,
                    status: f.status,
                    patchState: this.patchStateOf(f),
                })),
            })),
        })

        const workerResults = await this.mapWithConcurrency(
            clusters,
            WORKER_CONCURRENCY,
            async (cluster): Promise<WorkerOutcome> => {
                try {
                    const result = await this.runWorkerWithRetry(cluster, standards, send)
                    return { status: 'fulfilled', cluster, ...result }
                } catch (error) {
                    return { status: 'rejected', cluster, error }
                }
            },
        )

        const successful = workerResults.filter((result): result is WorkerSuccess => result.status === 'fulfilled')
        const failed = workerResults.filter((result): result is WorkerFailure => result.status === 'rejected')
        const partialReviews = successful.map(({ cluster, review }) => ({
            clusterId: cluster.id,
            label: cluster.label,
            review,
        }))

        if (partialReviews.length === 0) {
            throw new InternalServerErrorException('All cluster agents failed. Please try again.')
        }

        const coverage = this.buildCoverage(snapshot, clusters, successful, failed)
        let finalReview: ReviewData
        let synthesisStep = 0
        if (clusters.length === 1) {
            finalReview = partialReviews[0].review
        } else {
            send({ type: 'synthesis_start', clusterCount: partialReviews.length })
            finalReview = await this.synthesizeReview(prUrl, partialReviews, standards, coverage)
            synthesisStep = 1
        }

        const outcome = coverage.unreviewedFiles.length > 0 || coverage.failedClusters.length > 0
            ? 'partial'
            : 'complete'
        const merged = {
            ...finalReview,
            appliedStandards: standards?.appliedNames,
            coverage,
        }

        await this.completeReview(
            prUrl,
            'PR',
            merged,
            userId,
            conn,
            reviewId,
            Date.now() - startedAt,
            successful.length + synthesisStep,
            outcome,
        )
    }

    /** AI streaming phase — runs the model and emits thinking/tool/complete events. */
    private async streamAnalysis(
        userMessage: string,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        input: string,
        reviewType: 'CODE',
        userId: string,
        conn: SseConnection,
        reviewId?: string,
    ): Promise<void> {
        if (reviewType === 'CODE') {
            conn.send({ type: 'start' as const })
        }

        const _send = conn.send
        const _startedAt = conn.startedAt

        const system = standards
            ? `${buildSystemPrompt('CODE')}\n\nYour team's coding standards — apply these during the review:\n\n${standards.content}`
            : buildSystemPrompt('CODE')

        // PR reviews with pre-built context only need a few steps (no file-fetch tools).
        // Code reviews may still call runLinter.
        const MAX_STEPS = AGENT_MAX_STEPS[reviewType]

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream(_send)
        const { onChunk, onStepFinish, getToolCallCount } = this.buildStreamCallbacks(_send, pending, thinking)

        try {
            const result = runStreamText({
                model: this.aiService.defaultModel,
                system,
                messages: [{ role: 'user', content: userMessage }],
                // PR path: NO tools — context is fully pre-built from diffs. Giving the
                // model tools in this path causes it to run runLinter on every file.
                // Code path: linter only.
                tools: this.buildCodeAgentTools(),
                temperature: 0.2,

                stopWhen: ({ steps }: { steps: MinimalAiStep[] }) => {
                    const lastText = steps.at(-1)?.text ?? ''
                    try {
                        parseReviewText(lastText)
                        return true
                    } catch {
                        /* keep going */
                    }
                    return steps.length >= MAX_STEPS
                },

                prepareStep: ({ steps }: { steps: MinimalAiStep[] }) => {
                    if (steps.length >= MAX_STEPS - 1) return { toolChoice: 'none' as const }
                    return {}
                },

                onChunk,
                onStepFinish,
            })

            const [finalText, steps] = await Promise.all([result.text, result.steps])

            const allTexts = [finalText, ...steps.map((s) => s.text).reverse()].filter((t) => t.trim())
            let review: ReviewData | undefined
            for (const text of allTexts) {
                try {
                    review = parseReviewText(text)
                    break
                } catch {
                    /* try next */
                }
            }

            if (!review) {
                const message = 'The model did not return a valid review. Please try again.'
                this.logger.error(
                    `Stream: review parsing failed — steps: ${steps.length}, ` +
                        `last text: ${JSON.stringify(finalText.slice(0, 300))}`,
                )
                throw new InternalServerErrorException(message)
            }

            const merged = { ...review, appliedStandards: standards?.appliedNames }
            await this.completeReview(
                input,
                reviewType,
                merged,
                userId,
                conn,
                reviewId,
                Date.now() - _startedAt,
                getToolCallCount(),
            )
        } catch (err: unknown) {
            thinking.flushPending()
            throw err
        }
    }

    /** Persist a successful terminal transition before telling SSE clients to close. */
    private async completeReview(
        input: string,
        reviewType: 'CODE' | 'PR',
        review: ReviewData,
        userId: string,
        conn: SseConnection,
        reviewId: string | undefined,
        durationMs: number,
        stepCount: number,
        outcome: 'complete' | 'partial' = 'complete',
    ): Promise<void> {
        const event: ReviewStreamEvent = {
            type: 'complete',
            review: { ...review, id: reviewId ?? '' },
            durationMs,
            stepCount,
            outcome,
        }
        const savedId = await this.reviewRepository.saveReview(
            input,
            reviewType,
            review,
            userId,
            [...conn.getTrace(), event],
            reviewId,
            outcome,
        )

        // A missing ID for an existing session means cancellation (or another
        // terminal transition) won the atomic PENDING -> COMPLETE race.
        if (reviewId && !savedId) {
            this.logger.warn(`Skipped complete event for non-pending review ${reviewId}`)
            return
        }

        conn.send(event)
    }

    private async runWorkerWithRetry(
        cluster: ClusterPlan,
        standards: StandardsContext,
        send: (event: ReviewStreamEvent) => void,
    ): Promise<{ review: ReviewData; attempts: number; truncatedFiles: string[] }> {
        const workerStart = Date.now()
        const context = this.buildClusterContext(cluster)
        let lastError: unknown

        for (let attempt = 1; attempt <= WORKER_ATTEMPTS; attempt++) {
            try {
                const review = await this.runWorkerAttempt(cluster, standards, send, context.text, attempt)
                send({
                    type: 'cluster_done',
                    clusterId: cluster.id,
                    issueCount: review.issues.length,
                    durationMs: Date.now() - workerStart,
                    attempts: attempt,
                })
                return { review, attempts: attempt, truncatedFiles: context.truncatedFiles }
            } catch (error) {
                lastError = error
                if (attempt < WORKER_ATTEMPTS) {
                    send({
                        type: 'thinking',
                        clusterId: cluster.id,
                        text: 'The first worker attempt did not produce a valid review. Retrying with stricter output constraints.',
                    })
                }
            }
        }

        send({
            type: 'cluster_failed',
            clusterId: cluster.id,
            attempts: WORKER_ATTEMPTS,
            message: 'Worker could not produce a valid review after retrying.',
            durationMs: Date.now() - workerStart,
        })
        throw lastError instanceof Error ? lastError : new Error(`Worker agent for cluster "${cluster.id}" failed.`)
    }

    /** Run one worker attempt. Terminal cluster events are emitted by the retry wrapper. */
    private async runWorkerAttempt(
        cluster: ClusterPlan,
        standards: StandardsContext,
        send: (event: ReviewStreamEvent) => void,
        fileSection: string,
        attempt: number,
    ): Promise<ReviewData> {
        const retryInstruction = attempt > 1
            ? '\n\nRETRY REQUIREMENT: Return one valid JSON review object. Do not add trailing prose after the closing brace.'
            : ''

        const userMessage =
            `Review the following files from the pull request.\n\n` +
            `Your focus: ${cluster.focus}\n\n` +
            fileSection +
            retryInstruction

        const system = buildWorkerPrompt(cluster.label, cluster.focus, standards?.content)

        const tools: Record<string, unknown> = {
            runLinter: buildLinterTool(({ code, language }) => this.linterService.lint(code, language)),
        }

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream((event) => send({ ...event, clusterId: cluster.id }))
        const clusterSend = (event: ReviewStreamEvent) => send({ ...event, clusterId: cluster.id } as ReviewStreamEvent)

        const { onChunk, onStepFinish } = this.buildStreamCallbacks(clusterSend, pending, thinking)

        const result = runStreamText({
            model: this.aiService.defaultModel,
            system,
            messages: [{ role: 'user', content: userMessage }],
            tools,
            temperature: attempt > 1 ? 0 : 0.2,
            stopWhen: ({ steps }: { steps: MinimalAiStep[] }) => {
                const lastText = steps.at(-1)?.text ?? ''
                try {
                    parseReviewText(lastText)
                    return true
                } catch {
                    /* keep going */
                }
                return steps.length >= AGENT_MAX_STEPS.WORKER
            },
            prepareStep: ({ steps }: { steps: MinimalAiStep[] }) => {
                if (steps.length >= AGENT_MAX_STEPS.WORKER - 1) return { toolChoice: 'none' as const }
                return {}
            },
            onChunk,
            onStepFinish,
        })

        const [finalText, steps] = await Promise.all([result.text, result.steps])

        const allTexts = [finalText, ...steps.map((s) => s.text).reverse()].filter((t) => t.trim())
        let review: ReviewData | undefined
        for (const text of allTexts) {
            try {
                review = parseReviewText(text)
                break
            } catch {
                /* try next */
            }
        }

        if (!review) {
            throw new Error(`Worker agent for cluster "${cluster.id}" did not return a valid review.`)
        }

        return review
    }

    private buildClusterContext(cluster: ClusterPlan): { text: string; truncatedFiles: string[] } {
        let remaining = MAX_CLUSTER_PATCH_CHARS
        const truncatedFiles: string[] = []
        const sections: string[] = []

        for (const file of cluster.files) {
            if (!file.patch) {
                const header =
                    `### ${file.filename}  [+${file.additions} -${file.deletions}  ` +
                    `status: ${file.status}  context: ${this.patchStateOf(file)}]`
                sections.push(`${header}\n(no text diff available — review metadata and related files only)`)
                continue
            }

            const budget = Math.min(MAX_PATCH_CHARS, Math.max(0, remaining))
            const selected = this.selectPatchWithinBudget(file.patch, budget)
            remaining -= selected.text.length
            if (selected.truncated) {
                truncatedFiles.push(file.filename)
                ;(file as NormalizedPRFile).patchState = 'truncated'
            }
            const header =
                `### ${file.filename}  [+${file.additions} -${file.deletions}  ` +
                `status: ${file.status}  context: ${this.patchStateOf(file)}]`
            sections.push(`${header}\n${selected.text}`)
        }

        return { text: sections.join('\n\n'), truncatedFiles }
    }

    private selectPatchWithinBudget(patch: string, budget: number): { text: string; truncated: boolean } {
        if (patch.length <= budget) return { text: patch, truncated: false }
        const marker = '\n… [additional diff hunks omitted due review context budget]'
        if (budget <= marker.length) return { text: marker.trim(), truncated: true }

        const hunks = patch.split(/(?=^@@\s)/gm).filter(Boolean)
        const selected: string[] = []
        let used = marker.length
        for (const hunk of hunks) {
            if (used + hunk.length + 1 > budget) break
            selected.push(hunk.trimEnd())
            used += hunk.length + 1
        }

        if (selected.length === 0) {
            const lines: string[] = []
            let lineBudget = marker.length
            for (const line of patch.split('\n')) {
                if (lineBudget + line.length + 1 > budget) break
                lines.push(line)
                lineBudget += line.length + 1
            }
            selected.push(lines.join('\n'))
        }

        return { text: `${selected.join('\n')}${marker}`, truncated: true }
    }

    private patchStateOf(file: PRFile): NormalizedPRFile['patchState'] {
        return (file as Partial<NormalizedPRFile>).patchState ?? (file.patch ? 'full' : 'metadata_only')
    }

    private buildCoverage(
        snapshot: PRSnapshot,
        clusters: ClusterPlan[],
        successful: WorkerSuccess[],
        failed: WorkerFailure[],
    ): ReviewCoverage {
        const assigned = new Set(clusters.flatMap((cluster) => cluster.files.map((file) => file.filename)))
        const reviewed = new Set(successful.flatMap((result) => result.cluster.files.map((file) => file.filename)))
        const unreviewed = new Set(failed.flatMap((result) => result.cluster.files.map((file) => file.filename)))
        const truncated = new Set([
            ...snapshot.files.filter((file) => file.patchState === 'truncated').map((file) => file.filename),
            ...successful.flatMap((result) => result.truncatedFiles),
        ])
        const metadataOnly = snapshot.files
            .filter((file) => file.patchState === 'metadata_only' || file.patchState === 'binary')
            .map((file) => file.filename)

        return {
            totalFiles: snapshot.files.length,
            assignedFiles: assigned.size,
            reviewedFiles: reviewed.size,
            truncatedFiles: [...truncated].sort(),
            metadataOnlyFiles: [...new Set(metadataOnly)].sort(),
            unreviewedFiles: [...unreviewed].sort(),
            failedClusters: failed.map((result) => result.cluster.id),
            acquisitionSource: snapshot.source,
        }
    }

    private async mapWithConcurrency<T, R>(
        items: T[],
        limit: number,
        worker: (item: T, index: number) => Promise<R>,
    ): Promise<R[]> {
        const results = new Array<R>(items.length)
        let nextIndex = 0

        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (true) {
                const index = nextIndex++
                if (index >= items.length) return
                results[index] = await worker(items[index], index)
            }
        })

        await Promise.all(runners)
        return results
    }

    /** Extract the onChunk / onStepFinish callbacks so streamAnalysis stays focused on control flow.
     *  toolCallCount is owned here and exposed via getToolCallCount() to avoid a mutable closure leak. */
    private buildStreamCallbacks(
        _send: (event: ReviewStreamEvent) => void,
        pending: Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>,
        thinking: ThinkingStream,
    ) {
        let toolCallCount = 0

        return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onChunk: ({ chunk }: { chunk: any }) => {
                if (chunk.type === 'tool-call') {
                    // Flush any pending reasoning before showing a tool step.
                    thinking.flushPending()
                    const args = parseArgs(chunk.input ?? chunk.args)
                    pending.set(chunk.toolCallId, {
                        toolName: chunk.toolName,
                        args,
                        startedAt: Date.now(),
                    })
                    toolCallCount++
                    _send({
                        type: 'tool_start' as const,
                        tool: chunk.toolName,
                        callId: chunk.toolCallId,
                        label: toolStartLabel(chunk.toolName, args),
                        detail: toolStartDetail(chunk.toolName, args),
                    })
                }

                const textDelta: unknown = chunk.text ?? chunk.textDelta
                if (chunk.type === 'text-delta' && typeof textDelta === 'string') {
                    thinking.onDelta(textDelta)
                }
            },

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onStepFinish: ({ toolCalls, toolResults }: { toolCalls: any[]; toolResults: any[] }) => {
                for (const tr of toolResults ?? []) {
                    const p = pending.get(tr.toolCallId)
                    pending.delete(tr.toolCallId)
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const tc = (toolCalls ?? []).find((c: any) => c.toolCallId === tr.toolCallId)
                    const tcArgs = parseArgs(tc?.input ?? tc?.args)
                    const pArgs = p?.args ?? {}
                    const trArgs = parseArgs(tr.input ?? tr.args)
                    const args = pickArgs(pArgs, tcArgs, trArgs)
                    const output = tr.output ?? tr.result
                    const startedAt = p?.startedAt ?? Date.now()
                    _send({
                        type: 'tool_done' as const,
                        callId: tr.toolCallId,
                        label: toolDoneLabel(tr.toolName, args, output),
                        detail: toolDoneDetail(tr.toolName, args, output),
                        durationMs: Date.now() - startedAt,
                    })
                }
            },

            getToolCallCount: () => toolCallCount,
        }
    }

    /**
     * Run the synthesis LLM with two attempts and a guaranteed programmatic fallback.
     *
     * Attempt 1 — standard call (temperature 0.2).
     * Attempt 2 — temperature 0, reinforced JSON-only instruction, in case the first
     *             attempt produced prose wrapping around the JSON.
     * Fallback   — deterministic merge of worker reviews; always produces valid ReviewData.
     */
    private async synthesizeReview(
        prUrl: string,
        partialReviews: Array<{
            clusterId: string
            label: string
            review: ReviewData
        }>,
        standards: StandardsContext,
        coverage?: ReviewCoverage,
    ): Promise<ReviewData> {
        const baseSystem = standards
            ? `${buildSynthesisSystemPrompt()}\n\nYour team's coding standards:\n\n${standards.content}`
            : buildSynthesisSystemPrompt()
        const coverageContext = coverage
            ? `\n\nCoverage manifest (server-verified; do not claim failed clusters were reviewed):\n${JSON.stringify(coverage)}`
            : ''
        const userMessage = buildSynthesisUserMessage(prUrl, partialReviews) + coverageContext

        // ── Attempt 1: standard ───────────────────────────────────────────────
        try {
            const { text } = await runGenerateText({
                model: this.aiService.defaultModel,
                system: baseSystem,
                messages: [{ role: 'user', content: userMessage }],
                temperature: 0.2,
            })
            return parseReviewText(text)
        } catch (err) {
            this.logger.warn(`Synthesis attempt 1 failed: ${err instanceof Error ? err.message : err}`)
        }

        // ── Attempt 2: temperature 0 + reinforced JSON-only instruction ───────
        try {
            const { text } = await runGenerateText({
                model: this.aiService.defaultModel,
                system:
                    baseSystem +
                    '\n\nFINAL INSTRUCTION: Your entire response must be ONE JSON object. ' +
                    'Start with a line containing only { and end with a line containing only }. ' +
                    'Absolutely no text before or after the JSON.',
                messages: [{ role: 'user', content: userMessage }],
                temperature: 0,
            })
            return parseReviewText(text)
        } catch (err) {
            this.logger.warn(`Synthesis attempt 2 failed: ${err instanceof Error ? err.message : err}`)
        }

        // ── Fallback: deterministic merge — guaranteed valid ReviewData ────────
        this.logger.warn(`Both synthesis attempts failed for ${prUrl} — using programmatic merge fallback`)
        return this.mergeReviewsFallback(partialReviews)
    }

    /** Merge worker partial reviews deterministically — used when LLM synthesis fails twice. */
    private mergeReviewsFallback(
        partialReviews: Array<{
            clusterId: string
            label: string
            review: ReviewData
        }>,
    ): ReviewData {
        // Deduplicate issues by type+title+location key
        const seen = new Set<string>()
        const issues = partialReviews
            .flatMap(({ review }) => review.issues)
            .filter((i) => {
                const key = `${i.type}:${i.title}:${i.location}`
                if (seen.has(key)) return false
                seen.add(key)
                return true
            })

        const positives = [...new Set(partialReviews.flatMap(({ review }) => review.positives))]
        const avgScore = Math.round(
            partialReviews.reduce((sum, { review }) => sum + review.score, 0) / partialReviews.length,
        )
        const summary = partialReviews
            .map(({ label, review }) => `${label}: ${review.summary}`)
            .join(' · ')
            .slice(0, 400)

        return { summary, score: avgScore, issues, positives }
    }

    /** Pasted-code reviews keep the linter tool; PR acquisition is orchestrated before any model call. */
    private buildCodeAgentTools(): Record<string, unknown> {
        return {
            runLinter: buildLinterTool(({ code, language }) => this.linterService.lint(code, language)),
        }
    }

    private errMsg(err: unknown): string {
        return err instanceof Error ? err.message : String(err)
    }

    /** Preserve intentional user-facing HTTP errors; hide unexpected provider/DB details. */
    private publicErrorMessage(err: unknown): string {
        if (err instanceof HttpException) return err.message

        this.logger.error(`Review pipeline failed: ${this.errMsg(err)}`)
        return 'Review failed unexpectedly. Please try again.'
    }
}
