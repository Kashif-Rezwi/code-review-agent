import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { AiService } from '../ai/ai.service'
import {
    buildSystemPrompt,
    planClusters,
    buildDeterministicClusters,
    buildWorkerPrompt,
    buildSynthesisUserMessage,
    buildSynthesisSystemPrompt,
} from '@cra/ai'
import type { ReviewData, PRFile, ClusterPlan } from '@cra/ai'
import type { ReviewCoverage, ReviewStreamEvent } from '@cra/types'
import { GithubService } from '../github/github.service'
import { LinterService, type LintResult } from '../linter/linter.service'
import { RagService } from '../rag/rag.service'
import { ReviewRepository } from './review.repository'
import { QueueService } from '../queue/queue.service'
import { RedisService } from '../queue/redis.service'
import { ReviewDispatcherService } from './review-dispatcher.service'
import {
    OperationDeadlineError,
    ReviewCancelledError,
    ReviewDeadlineError,
    ReviewCancellationService,
    operationDeadline,
    throwSignalReason,
} from '../queue/review-cancellation.service'
import {
    asRecord,
    createLinterRuntimeTool,
    ProviderStreamError,
    runReviewGenerate,
    stringValue,
} from '../ai/ai-runtime.adapter'
import { AI_POLICY } from '../ai/ai-policy'
import { waitBeforeProviderRetry } from '../ai/provider-backoff'
import type { SseConnection } from './review.sse'
import { parseReviewText } from './review-parser.util'
import { pickArgs, toolStartLabel, toolDoneLabel } from './review.formatter'
import { ThinkingStream } from './review.thinking'
import { runReviewAgent } from './review.agent'
import type { NormalizedPRFile, PRSnapshot } from '../github/github.types'

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
        private reviewRepository: ReviewRepository,
        private githubService: GithubService,
        private linterService: LinterService,
        private ragService: RagService,
        private aiService: AiService,
        private queueService: QueueService,
        private redisService: RedisService,
        private reviewDispatcher: ReviewDispatcherService,
        private reviewCancellation: ReviewCancellationService,
    ) {}

    async createSession(type: 'CODE' | 'PR', input: string, userId: string) {
        const session = await this.reviewRepository.createSession(type, input, userId)
        if (!session) throw new InternalServerErrorException('Database not configured or failed to create session')
        // The review and dispatch intent were committed atomically. The kick is
        // opportunistic; the two-second poller guarantees eventual handoff.
        void this.reviewDispatcher.kick()
        return session
    }

    /**
     * Cancels an in-progress review:
     * 1. Removes the BullMQ job if it hasn't started yet.
     * 2. Marks the DB record as CANCELLED (no-op if already terminal).
     * 3. Emits a terminal error event to Redis so any live SSE client closes immediately.
     */
    async cancelReview(reviewId: string): Promise<void> {
        const wasCancelled = await this.reviewRepository.markCancelled(reviewId)
        // Only push the terminal event when we actually flipped the status.
        // If the review already reached COMPLETE/FAILED, emitting an error event
        // here would corrupt the Redis replay list seen by future SSE connections.
        if (wasCancelled) {
            const results = await Promise.allSettled([
                this.queueService.removeJob(reviewId),
                this.reviewCancellation.requestCancellation(reviewId),
            ])
            for (const result of results) {
                if (result.status === 'rejected') {
                    this.logger.warn(`Cancellation side effect failed for ${reviewId}: ${this.errMsg(result.reason)}`)
                }
            }
            try {
                await this.redisService.emitEvent(reviewId, JSON.stringify({ type: 'error', message: 'Review cancelled' }))
            } catch (error) {
                // PostgreSQL is authoritative; the streamer reconstructs this
                // terminal CANCELLED state even if Redis is unavailable.
                this.logger.warn(`Could not append cancellation event for ${reviewId}: ${this.errMsg(error)}`)
            }
        }
    }

    async runForQueue(
        reviewId: string,
        type: 'CODE' | 'PR',
        input: string,
        userId: string,
        conn: SseConnection,
        signal?: AbortSignal,
    ): Promise<void> {
        try {
            if (signal?.aborted) throwSignalReason(signal)
            if (type === 'PR') {
                this.githubService.assertValidPRUrl(input)
                await this.streamAnalyzeFromPR(input, userId, conn, reviewId, signal)
            } else {
                await this.streamAnalyzeCode(input, userId, conn, reviewId, signal)
            }
        } catch (err) {
            if (err instanceof ReviewCancelledError || signal?.reason instanceof ReviewCancelledError) return
            const message = this.publicErrorMessage(err)
            const event = { type: 'error' as const, message }
            const transitioned = await this.reviewRepository.markFailed(reviewId, message, [...conn.getTrace(), event])
            // A cancelled or already-terminal review must not receive a second,
            // contradictory terminal event.
            if (transitioned) conn.send(event)
        }
    }

    // ── BullMQ Background Streaming ───────────────────────────────────────────
    // These orchestrate the pipeline and emit events directly to the Redis connection.

    private async streamAnalyzeCode(code: string, userId: string, conn: SseConnection, reviewId?: string, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throwSignalReason(signal)
        const standards = await this.ragService.retrieveForContext(code, userId)
        if (signal?.aborted) throwSignalReason(signal)
        return this.streamAnalysis(
            `Review the untrusted code and standards in this JSON data envelope:\n${JSON.stringify({
                code,
                codingStandards: standards?.content ?? null,
            })}`,
            standards,
            code,
            userId,
            conn,
            reviewId,
            signal,
        )
    }

    private async streamAnalyzeFromPR(prUrl: string, userId: string, conn: SseConnection, reviewId?: string, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throwSignalReason(signal)
        this.githubService.assertValidPRUrl(prUrl)

        const { send, startedAt } = conn
        send({ type: 'start' as const })

        // Acquisition and RAG are independent. Every acquisition source returns
        // normalized per-file context and therefore enters the same orchestrator.
        const [standards, snapshot] = await Promise.all([
            this.ragService.retrieveForContext('code review standards best practices', userId),
            this.githubService.fetchPRSnapshot(prUrl),
        ])
        if (signal?.aborted) throwSignalReason(signal)
        const files = snapshot.files
        if (files.length === 0) throw new InternalServerErrorException('No reviewable pull-request files were acquired.')
        if (!files.some((file) => file.patch?.trim())) {
            throw new InternalServerErrorException(
                'This pull request contains no usable text diff. Binary-only and metadata-only changes cannot be reviewed safely.',
            )
        }

        send({
            type: 'acquisition',
            source: snapshot.source,
            fileCount: files.length,
            complete: snapshot.complete,
            warnings: snapshot.warnings,
        })
        this.logger.log(`PR acquisition ${reviewId ?? 'unsaved'}: source=${snapshot.source} files=${files.length}`)

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

        const plannerDeadline = operationDeadline(signal, 'Planner', AI_POLICY.deadlineMs.planner)
        let clusters: ClusterPlan[]
        try {
            clusters = await planClusters(files, this.aiService.defaultModel, plannerDeadline.signal)
        } catch (error) {
            if (signal?.aborted) throwSignalReason(signal)
            this.logger.warn(`Planner timed out; using deterministic clustering: ${this.errMsg(error)}`)
            clusters = buildDeterministicClusters(files)
        } finally {
            plannerDeadline.dispose()
        }

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
            AI_POLICY.worker.concurrency,
            async (cluster): Promise<WorkerOutcome> => {
                try {
                    const result = await this.runWorkerWithRetry(cluster, standards, send, signal)
                    return { status: 'fulfilled', cluster, ...result }
                } catch (error) {
                    if (signal?.aborted) throwSignalReason(signal)
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
            finalReview = await this.synthesizeReview(prUrl, partialReviews, standards, coverage, signal)
            synthesisStep = 1
        }

        const outcome = coverage.unreviewedFiles.length > 0 || coverage.failedClusters.length > 0
            ? 'partial'
            : 'complete'
        this.logger.log(
            `PR review ${reviewId ?? 'unsaved'} outcome=${outcome} ` +
            `failedClusters=${coverage.failedClusters.length} unreviewedFiles=${coverage.unreviewedFiles.length}`,
        )
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

    /** AI streaming phase — runs the pasted-code agent and emits thinking/tool/complete events. */
    private async streamAnalysis(
        userMessage: string,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        input: string,
        userId: string,
        conn: SseConnection,
        reviewId?: string,
        signal?: AbortSignal,
    ): Promise<void> {
        conn.send({ type: 'start' as const })

        const _send = conn.send
        const _startedAt = conn.startedAt

        const system = buildSystemPrompt('CODE')

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream(_send)
        // Structured lint outcomes keyed by the exact code string: the model receives
        // only the plain-text `output`, while the SSE labeler reads real counts from here.
        const lintOutcomes = new Map<string, LintResult>()
        const { onChunk, onStepFinish, getToolCallCount } = this.buildStreamCallbacks(_send, pending, thinking, lintOutcomes)

        try {
            const callDeadline = operationDeadline(signal, 'Pasted-code review', AI_POLICY.deadlineMs.codeReview)
            let review: ReviewData
            try {
                // Linter tool only — the PR path pre-builds context and stays tool-free.
                review = await runReviewAgent({
                    model: this.aiService.defaultModel,
                    system,
                    userMessage,
                    tools: this.buildCodeAgentTools(lintOutcomes),
                    temperature: AI_POLICY.temperature.standard,
                    maxOutputTokens: AI_POLICY.maxOutputTokens.code,
                    maxSteps: AI_POLICY.maxSteps.code,
                    signal: callDeadline.signal,
                    callbacks: { onChunk, onStepFinish },
                })
            } finally {
                callDeadline.dispose()
            }

            const merged = { ...review, appliedStandards: standards?.appliedNames }
            await this.completeReview(
                input,
                'CODE',
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
        await conn.flush()
    }

    private async runWorkerWithRetry(
        cluster: ClusterPlan,
        standards: StandardsContext,
        send: (event: ReviewStreamEvent) => void,
        signal?: AbortSignal,
    ): Promise<{ review: ReviewData; attempts: number; truncatedFiles: string[] }> {
        const workerStart = Date.now()
        const context = this.buildClusterContext(cluster, standards?.content)
        let lastError: unknown

        for (let attempt = 1; attempt <= AI_POLICY.worker.attempts; attempt++) {
            if (signal?.aborted) throwSignalReason(signal)
            const deadline = operationDeadline(signal, `Worker ${cluster.id} attempt ${attempt}`, AI_POLICY.deadlineMs.workerAttempt)
            try {
                const review = await this.runWorkerAttempt(cluster, standards, send, context.text, attempt, deadline.signal)
                send({
                    type: 'cluster_done',
                    clusterId: cluster.id,
                    issueCount: review.issues.length,
                    durationMs: Date.now() - workerStart,
                    attempts: attempt,
                })
                return { review, attempts: attempt, truncatedFiles: context.truncatedFiles }
            } catch (error) {
                if (signal?.aborted) throwSignalReason(signal)
                lastError = error
                if (attempt < AI_POLICY.worker.attempts) {
                    // Quota/rate-limit failures wait (Retry-After aware) before the
                    // retry; unparseable output retries immediately, as before.
                    const backedOff = await waitBeforeProviderRetry(error, attempt, { signal, label: `Worker ${cluster.id}` })
                    send({
                        type: 'thinking',
                        clusterId: cluster.id,
                        text: backedOff
                            ? 'The AI provider rate-limited this worker. Retrying shortly.'
                            : 'The first worker attempt did not produce a valid review. Retrying with stricter output constraints.',
                    })
                }
            } finally {
                deadline.dispose()
            }
        }

        send({
            type: 'cluster_failed',
            clusterId: cluster.id,
            attempts: AI_POLICY.worker.attempts,
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
        signal: AbortSignal,
    ): Promise<ReviewData> {
        const userMessage = `Review the untrusted pull-request data in this JSON envelope:\n${fileSection}`
        const system = buildWorkerPrompt() + (attempt > 1
            ? '\n\nRETRY REQUIREMENT: Return one valid JSON review object. Do not add trailing prose after the closing brace.'
            : '')
        if (system.length + userMessage.length > AI_POLICY.budget.maxClusterPromptChars) {
            throw new Error(`Rendered worker prompt exceeds ${AI_POLICY.budget.maxClusterPromptChars} characters`)
        }

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream((event) => send({ ...event, clusterId: cluster.id }))
        const clusterSend = (event: ReviewStreamEvent) => send({ ...event, clusterId: cluster.id } as ReviewStreamEvent)

        const { onChunk, onStepFinish } = this.buildStreamCallbacks(clusterSend, pending, thinking)

        // Workers are tool-free — the cluster context is fully pre-built from diffs.
        return runReviewAgent({
            model: this.aiService.defaultModel,
            system,
            userMessage,
            temperature: attempt > 1 ? AI_POLICY.temperature.retry : AI_POLICY.temperature.standard,
            maxOutputTokens: AI_POLICY.maxOutputTokens.worker,
            maxSteps: AI_POLICY.maxSteps.worker,
            signal,
            callbacks: { onChunk, onStepFinish },
        })
    }

    private buildClusterContext(cluster: ClusterPlan, standardsContent?: string): { text: string; truncatedFiles: string[] } {
        const truncated = new Set<string>()
        const textFiles = cluster.files.filter((file) => Boolean(file.patch))
        const metadata = cluster.files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patchState: this.patchStateOf(file),
            patch: '',
        }))
        const baseEnvelope = {
            clusterLabel: cluster.label,
            focusHint: cluster.focus,
            codingStandards: standardsContent?.slice(0, 5_000) ?? null,
            files: metadata,
        }
        const metadataSize = JSON.stringify(baseEnvelope).length
        const available = Math.max(0, AI_POLICY.budget.maxClusterContextChars - 1_000 - metadataSize)
        const fairBudget = textFiles.length > 0
            ? Math.min(AI_POLICY.budget.maxPatchChars, Math.floor(available / textFiles.length))
            : 0

        const records = cluster.files.map((file) => {
            if (!file.patch) return metadata.find((entry) => entry.filename === file.filename)!
            const selected = this.selectPatchWithinBudget(file.patch, fairBudget)
            if (selected.truncated) truncated.add(file.filename)
            return {
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                patchState: selected.truncated ? 'truncated' : this.patchStateOf(file),
                patch: selected.text,
            }
        })

        const envelope = {
            clusterLabel: cluster.label,
            focusHint: cluster.focus,
            codingStandards: standardsContent?.slice(0, 5_000) ?? null,
            files: records,
        }
        let text = JSON.stringify(envelope)
        while (text.length > AI_POLICY.budget.maxClusterContextChars - 500) {
            const largest = records
                .filter((record) => record.patch.length > 0)
                .sort((left, right) => right.patch.length - left.patch.length || left.filename.localeCompare(right.filename))[0]
            if (!largest) throw new Error('Cluster metadata exceeds the safe worker prompt budget')
            const selected = this.selectPatchWithinBudget(largest.patch, Math.floor(largest.patch.length / 2))
            largest.patch = selected.text
            largest.patchState = 'truncated'
            truncated.add(largest.filename)
            text = JSON.stringify(envelope)
        }

        return { text, truncatedFiles: [...truncated].sort() }
    }

    private selectPatchWithinBudget(patch: string, budget: number): { text: string; truncated: boolean } {
        if (patch.length <= budget) return { text: patch, truncated: false }
        const marker = '\n… [additional diff hunks omitted due review context budget]'
        if (budget <= marker.length) return { text: '', truncated: true }

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
     *  toolCallCount is owned here and exposed via getToolCallCount() to avoid a mutable closure leak.
     *  Pinned AI SDK v6 shapes only: tool-call chunks carry `input`, text deltas carry
     *  `text`, tool results carry `output`. */
    private buildStreamCallbacks(
        _send: (event: ReviewStreamEvent) => void,
        pending: Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>,
        thinking: ThinkingStream,
        lintOutcomes?: Map<string, LintResult>,
    ) {
        let toolCallCount = 0

        return {
            onChunk: ({ chunk: rawChunk }: { chunk: unknown }) => {
                const chunk = asRecord(rawChunk)
                const chunkType = stringValue(chunk.type)
                if (chunkType === 'tool-call') {
                    const toolCallId = stringValue(chunk.toolCallId)
                    const toolName = stringValue(chunk.toolName)
                    if (!toolCallId || !toolName) return
                    // Flush any pending reasoning before showing a tool step.
                    thinking.flushPending()
                    const args = asRecord(chunk.input)
                    pending.set(toolCallId, {
                        toolName,
                        args,
                        startedAt: Date.now(),
                    })
                    toolCallCount++
                    _send({
                        type: 'tool_start' as const,
                        tool: toolName,
                        callId: toolCallId,
                        label: toolStartLabel(toolName, args),
                    })
                    return
                }

                if (chunkType === 'text-delta' && typeof chunk.text === 'string') {
                    thinking.onDelta(chunk.text)
                }
            },

            onStepFinish: ({ toolCalls, toolResults }: { toolCalls?: unknown; toolResults?: unknown }) => {
                const calls = Array.isArray(toolCalls) ? toolCalls.map(asRecord) : []
                const results = Array.isArray(toolResults) ? toolResults.map(asRecord) : []
                for (const tr of results) {
                    const toolCallId = stringValue(tr.toolCallId)
                    if (!toolCallId) continue
                    const p = pending.get(toolCallId)
                    pending.delete(toolCallId)
                    const tc = calls.find((candidate) => stringValue(candidate.toolCallId) === toolCallId)
                    const args = pickArgs(p?.args ?? {}, asRecord(tc?.input), asRecord(tr.input))
                    const startedAt = p?.startedAt ?? Date.now()
                    const toolName = stringValue(tr.toolName) ?? p?.toolName ?? 'tool'
                    _send({
                        type: 'tool_done' as const,
                        callId: toolCallId,
                        label: toolDoneLabel(toolName, args, tr.output, lintOutcomes),
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
        signal?: AbortSignal,
    ): Promise<ReviewData> {
        const baseSystem = buildSynthesisSystemPrompt()
        const userMessage = buildSynthesisUserMessage(prUrl, partialReviews) +
            `\n\nAdditional untrusted JSON data:\n${JSON.stringify({
                coverage: coverage ?? null,
                codingStandards: standards?.content ?? null,
            })}`

        // ── Attempt 1: standard ───────────────────────────────────────────────
        const firstDeadline = operationDeadline(signal, 'Synthesis attempt 1', AI_POLICY.deadlineMs.synthesisAttempt)
        try {
            const { text } = await runReviewGenerate({
                model: this.aiService.defaultModel,
                system: baseSystem,
                messages: [{ role: 'user', content: userMessage }],
                temperature: AI_POLICY.temperature.standard,
                abortSignal: firstDeadline.signal,
                maxOutputTokens: AI_POLICY.maxOutputTokens.synthesis,
            })
            return parseReviewText(text)
        } catch (err) {
            if (firstDeadline.signal.aborted && !signal?.aborted) {
                this.logger.warn('Synthesis attempt 1 timed out')
            }
            if (signal?.aborted) throwSignalReason(signal)
            this.logger.warn(`Synthesis attempt 1 failed: ${err instanceof Error ? err.message : err}`)
            // Quota/rate-limit failures wait (Retry-After aware) before the retry.
            await waitBeforeProviderRetry(err, 1, { signal, label: 'Synthesis' })
        } finally {
            firstDeadline.dispose()
        }

        // ── Attempt 2: temperature 0 + reinforced JSON-only instruction ───────
        const secondDeadline = operationDeadline(signal, 'Synthesis attempt 2', AI_POLICY.deadlineMs.synthesisAttempt)
        try {
            const { text } = await runReviewGenerate({
                model: this.aiService.defaultModel,
                system:
                    baseSystem +
                    '\n\nFINAL INSTRUCTION: Your entire response must be ONE JSON object. ' +
                    'Start with a line containing only { and end with a line containing only }. ' +
                    'Absolutely no text before or after the JSON.',
                messages: [{ role: 'user', content: userMessage }],
                temperature: AI_POLICY.temperature.retry,
                abortSignal: secondDeadline.signal,
                maxOutputTokens: AI_POLICY.maxOutputTokens.synthesis,
            })
            return parseReviewText(text)
        } catch (err) {
            if (signal?.aborted) throwSignalReason(signal)
            this.logger.warn(`Synthesis attempt 2 failed: ${err instanceof Error ? err.message : err}`)
        } finally {
            secondDeadline.dispose()
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
            .slice(0, 100)

        const positives = [...new Set(partialReviews.flatMap(({ review }) => review.positives))].slice(0, 50)
        const avgScore = Math.round(
            partialReviews.reduce((sum, { review }) => sum + review.score, 0) / partialReviews.length,
        )
        const summary = partialReviews
            .map(({ label, review }) => `${label}: ${review.summary}`)
            .join(' · ')
            .slice(0, 2_000)

        return { summary, score: avgScore, issues, positives }
    }

    /** Pasted-code reviews keep the linter tool; PR acquisition is orchestrated before any model call. */
    private buildCodeAgentTools(lintOutcomes: Map<string, LintResult>): Record<string, unknown> {
        return {
            runLinter: createLinterRuntimeTool(
                ({ code, language }) => this.linterService.lint(code, language),
                lintOutcomes,
            ),
        }
    }

    private errMsg(err: unknown): string {
        return err instanceof Error ? err.message : String(err)
    }

    /** Preserve intentional user-facing HTTP errors; hide unexpected provider/DB details. */
    private publicErrorMessage(err: unknown): string {
        if (err instanceof ReviewDeadlineError) {
            return 'Review exceeded the five-minute processing deadline. Try a smaller pull request or retry later.'
        }
        if (err instanceof OperationDeadlineError) {
            return `${err.operation} timed out. Please try again.`
        }
        if (err instanceof ProviderStreamError) {
            // The detail (billing/quota/auth) stays in the server log; the public
            // message stays generic but correctly blames the provider, not the model.
            this.logger.error(`Review pipeline failed: ${this.errMsg(err)}`)
            return 'The AI provider returned an error. Please try again later.'
        }
        if (err instanceof HttpException) return err.message

        this.logger.error(`Review pipeline failed: ${this.errMsg(err)}`)
        return 'Review failed unexpectedly. Please try again.'
    }
}
