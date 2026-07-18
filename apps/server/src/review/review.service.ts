import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { generateText, streamText } from 'ai'
import { AiService } from '../ai/ai.service'
import {
    buildSystemPrompt,
    createFetchGithubPRTool,
    createListPRFilesTool,
    createFetchFileContentTool,
    createRunLinterTool,
    planClusters,
    buildWorkerPrompt,
    buildSynthesisUserMessage,
    buildSynthesisSystemPrompt,
} from '@cra/ai'
import type { ReviewData, PRFile, ClusterPlan } from '@cra/ai'
import type { ReviewStreamEvent } from '@cra/types'
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

/** Maximum agent loop steps per review type. */
const AGENT_MAX_STEPS = { CODE: 10, PR: 2, WORKER: 5 } as const

/** Maximum diff characters forwarded to each worker agent per file.
 *  Keeps prompts within token budget while preserving most of the useful signal. */
const MAX_PATCH_CHARS = 3_000

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

        // ── Phase 1: Fetch files and RAG standards in parallel ────────────
        const filesPromise: Promise<{
            files: PRFile[] | null
            error: unknown | null
        }> = this.githubService
            .fetchPRFiles(prUrl)
            .then((files) => ({ files, error: null }))
            .catch((error) => ({ files: null, error }))

        const [standards, fileResult] = await Promise.all([
            this.ragService.retrieveForContext('code review standards best practices', userId),
            filesPromise,
        ])
        const { files, error: fileListError } = fileResult

        // If the structured file-list endpoint is unavailable, fetch an actual
        // unified diff. Never ask a model to browse a bare URL: PR_STREAM has no
        // GitHub tools and is only valid when source context is preloaded.
        const hasReviewablePatch = files?.some((file) => file.patch?.trim()) ?? false
        if (!files || files.length === 0 || !hasReviewablePatch) {
            const reason = fileListError
                ? this.errMsg(fileListError)
                : files?.length
                  ? 'GitHub returned changed files without reviewable patches'
                  : 'GitHub returned an empty changed-file list'
            this.logger.warn(
                `PR file list unavailable for review ${reviewId ?? 'unsaved'}; ` +
                    `using unified diff fallback: ${reason}`,
            )

            const diff = await this.githubService.fetchPRDiff(prUrl)
            const userMessage =
                `Please review this GitHub pull request: ${prUrl}\n\n` +
                `The structured changed-file list was unavailable, so the actual ` +
                `unified diff is provided below. Analyse only this supplied code context.\n\n` +
                `<pull_request_diff>\n${diff}\n</pull_request_diff>`

            return this.streamAnalysis(userMessage, standards, prUrl, 'PR', userId, conn, reviewId)
        }

        // ── Phase 1b: Emit file list for the Data Collection stage ────────
        // Fires before planning so the UI shows "Reading files…" first,
        // then transitions to the Planning stage when cluster_plan arrives.
        send({
            type: 'task_plan' as const,
            tasks: files.map((f) => ({
                id: f.filename,
                label: f.filename.split('/').pop() ?? f.filename,
            })),
        })
        for (const f of files) {
            const diffLines = f.patch ? f.patch.split('\n').length : 0
            const detail = diffLines > 0 ? `+${f.additions} -${f.deletions} · ${diffLines} diff lines` : f.status
            send({
                type: 'task_update' as const,
                taskId: f.filename,
                status: 'done',
                detail,
            })
        }

        // ── Phase 2: Plan clusters ────────────────────────────────────────
        // Use lightweight LLM call to plan clusters intelligently.
        // Falls back to single "general" cluster automatically on error.
        const clusters = await planClusters(files, this.aiService.provider)

        // Tell the UI exactly what clusters exist — it renders panels immediately
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
                })),
            })),
        })

        // ── Phase 3: Run all worker agents in parallel ────────────────────
        // Promise.allSettled means one failing cluster never blocks the others.
        const workerResults = await Promise.allSettled(
            clusters.map((cluster) => this.runWorkerAgent(cluster, standards, send)),
        )

        // Collect successful results — failed clusters are noted but not fatal
        const partialReviews = workerResults
            .map((result, i) => ({ result, cluster: clusters[i] }))
            .filter(({ result }) => result.status === 'fulfilled')
            .map(({ result, cluster }) => ({
                clusterId: cluster.id,
                label: cluster.label,
                review: (result as PromiseFulfilledResult<ReviewData>).value,
            }))

        if (partialReviews.length === 0) {
            throw new InternalServerErrorException('All cluster agents failed. Please try again.')
        }

        // ── Phase 4a: Single-cluster shortcut — skip synthesis ────────────
        // Small PRs (≤3 files) produce one cluster — its review is the final output.
        if (partialReviews.length === 1) {
            const only = partialReviews[0].review
            const merged = { ...only, appliedStandards: standards?.appliedNames }
            await this.completeReview(prUrl, 'PR', merged, userId, conn, reviewId, Date.now() - startedAt, 1)
            return
        }

        // ── Phase 4b: Synthesis agent ─────────────────────────────────────
        // Two-attempt LLM synthesis with a programmatic merge fallback so a
        // parse failure never surfaces as an error to the user.
        const finalReview = await this.synthesizeReview(prUrl, partialReviews, standards)
        const merged = {
            ...finalReview,
            appliedStandards: standards?.appliedNames,
        }

        await this.completeReview(
            prUrl,
            'PR',
            merged,
            userId,
            conn,
            reviewId,
            Date.now() - startedAt,
            clusters.length + 1,
        )
    }

    /** AI streaming phase — runs the model and emits thinking/tool/complete events. */
    private async streamAnalysis(
        userMessage: string,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        input: string,
        reviewType: 'CODE' | 'PR',
        userId: string,
        conn: SseConnection,
        reviewId?: string,
    ): Promise<void> {
        if (reviewType === 'CODE') {
            conn.send({ type: 'start' as const })
        }

        const _send = conn.send
        const _startedAt = conn.startedAt

        const promptContext = reviewType === 'PR' ? 'PR_STREAM' : 'CODE'
        const system = standards
            ? `${buildSystemPrompt(promptContext)}\n\nYour team's coding standards — apply these during the review:\n\n${standards.content}`
            : buildSystemPrompt(promptContext)

        // PR reviews with pre-built context only need a few steps (no file-fetch tools).
        // Code reviews may still call runLinter.
        const MAX_STEPS = AGENT_MAX_STEPS[reviewType]

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream(_send)
        const { onChunk, onStepFinish, getToolCallCount } = this.buildStreamCallbacks(_send, pending, thinking)

        try {
            const result = streamText({
                model: this.aiService.defaultModel,
                system,
                messages: [{ role: 'user', content: userMessage }],
                // PR path: NO tools — context is fully pre-built from diffs. Giving the
                // model tools in this path causes it to run runLinter on every file.
                // Code path: linter only.
                ...(reviewType === 'CODE' && { tools: this.buildAgentTools('CODE') }),
                temperature: 0.2,

                stopWhen: ({ steps }) => {
                    const lastText = steps.at(-1)?.text ?? ''
                    try {
                        parseReviewText(lastText)
                        return true
                    } catch {
                        /* keep going */
                    }
                    return steps.length >= MAX_STEPS
                },

                prepareStep: ({ steps }) => {
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
    ): Promise<void> {
        const event: ReviewStreamEvent = {
            type: 'complete',
            review: { ...review, id: reviewId ?? '' },
            durationMs,
            stepCount,
        }
        const savedId = await this.reviewRepository.saveReview(
            input,
            reviewType,
            review,
            userId,
            [...conn.getTrace(), event],
            reviewId,
        )

        // A missing ID for an existing session means cancellation (or another
        // terminal transition) won the atomic PENDING -> COMPLETE race.
        if (reviewId && !savedId) {
            this.logger.warn(`Skipped complete event for non-pending review ${reviewId}`)
            return
        }

        conn.send(event)
    }

    /** Run one cluster's worker agent, emitting SSE events tagged with clusterId. */
    private async runWorkerAgent(
        cluster: ClusterPlan,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        send: (event: ReviewStreamEvent) => void,
    ): Promise<ReviewData> {
        const workerStart = Date.now()

        const fileSection = cluster.files
            .map((f) => {
                const patch = f.patch
                    ? f.patch.length > MAX_PATCH_CHARS
                        ? f.patch.slice(0, MAX_PATCH_CHARS) + '\n… [diff truncated]'
                        : f.patch
                    : `(no diff — ${f.status})`
                return `### ${f.filename}  [+${f.additions} -${f.deletions}  status: ${f.status}]\n${patch}`
            })
            .join('\n\n')

        const userMessage =
            `Review the following files from the pull request.\n\n` + `Your focus: ${cluster.focus}\n\n` + fileSection

        const system = buildWorkerPrompt(cluster.label, cluster.focus, standards?.content)

        const tools = {
            runLinter: createRunLinterTool(({ code, language }) => this.linterService.lint(code, language)),
        }

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream((event) => send({ ...event, clusterId: cluster.id }))
        const clusterSend = (event: ReviewStreamEvent) => send({ ...event, clusterId: cluster.id } as ReviewStreamEvent)

        const { onChunk, onStepFinish } = this.buildStreamCallbacks(clusterSend, pending, thinking)

        const result = streamText({
            model: this.aiService.defaultModel,
            system,
            messages: [{ role: 'user', content: userMessage }],
            tools,
            temperature: 0.2,
            stopWhen: ({ steps }) => {
                const lastText = steps.at(-1)?.text ?? ''
                try {
                    parseReviewText(lastText)
                    return true
                } catch {
                    /* keep going */
                }
                return steps.length >= AGENT_MAX_STEPS.WORKER
            },
            prepareStep: ({ steps }) => {
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

        send({
            type: 'cluster_done' as const,
            clusterId: cluster.id,
            issueCount: review.issues.length,
            durationMs: Date.now() - workerStart,
        })

        return review
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
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
    ): Promise<ReviewData> {
        const baseSystem = standards
            ? `${buildSynthesisSystemPrompt()}\n\nYour team's coding standards:\n\n${standards.content}`
            : buildSynthesisSystemPrompt()
        const userMessage = buildSynthesisUserMessage(prUrl, partialReviews)

        // ── Attempt 1: standard ───────────────────────────────────────────────
        try {
            const { text } = await generateText({
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
            const { text } = await generateText({
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

    /** Wire up the required agent tools based on whether this is a PR or pasted code review. */
    private buildAgentTools(reviewType: 'CODE' | 'PR') {
        const baseTools = {
            runLinter: createRunLinterTool(({ code, language }) => this.linterService.lint(code, language)),
        }

        if (reviewType === 'CODE') {
            return baseTools
        }

        // PRs get all GitHub API capabilities on top of the linter
        return {
            ...baseTools,
            fetchGithubPR: createFetchGithubPRTool(async ({ prUrl }) => {
                try {
                    return await this.githubService.fetchPRDiff(prUrl)
                } catch (err) {
                    return `[Tool error: ${this.errMsg(err)}. Follow the OUTPUT RULE and respond with JSON now.]`
                }
            }),
            listPRFiles: createListPRFilesTool(async ({ prUrl }) => {
                try {
                    return await this.githubService.fetchPRFiles(prUrl)
                } catch (err) {
                    return `[Tool error: ${this.errMsg(err)}. Use fetchGithubPR as fallback.]` as unknown as PRFile[]
                }
            }),
            fetchFileContent: createFetchFileContentTool(async ({ prUrl, filePath }) => {
                try {
                    return await this.githubService.fetchFileContent(prUrl, filePath)
                } catch (err) {
                    return `[Tool error: ${this.errMsg(err)}. Continue the review without this file's content.]`
                }
            }),
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
