import {
    Injectable,
    HttpException,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { generateText, streamText } from 'ai'
import { AiService } from '../ai/ai.service'
import {
    buildSystemPrompt,
    ReviewDataSchema,
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
import {
    parseArgs, pickArgs,
    toolStartLabel, toolStartDetail,
    toolDoneLabel, toolDoneDetail,
} from './review.formatter'
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
    ) {
    }

    async createSession(type: 'CODE' | 'PR', input: string, userId: string) {
        const session = await this.reviewRepository.createSession(type, input, userId)
        if (!session) throw new InternalServerErrorException('Database not configured or failed to create session')
        return session
    }

    async markFailed(reviewId: string, message: string) {
        await this.reviewRepository.markFailed(reviewId, message)
    }

    /**
     * Cancels an in-progress review:
     * 1. Removes the BullMQ job if it hasn't started yet.
     * 2. Marks the DB record as CANCELLED (no-op if already terminal).
     * 3. Emits a terminal error event to Redis so any live SSE client closes immediately.
     */
    async cancelReview(reviewId: string): Promise<void> {
        await this.queueService.removeJob(reviewId)
        await this.reviewRepository.markCancelled(reviewId)
        await this.redisService.emitEvent(
            reviewId,
            JSON.stringify({ type: 'error', message: 'Review cancelled' }),
        )
    }

    async runForQueue(reviewId: string, type: 'CODE' | 'PR', input: string, userId: string, conn: SseConnection): Promise<void> {
        try {
            if (type === 'PR') {
                this.githubService.assertValidPRUrl(input)
                await this.streamAnalyzeFromPR(input, userId, conn, reviewId)
            } else {
                await this.streamAnalyzeCode(input, userId, conn, reviewId)
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Review failed'
            conn.send({ type: 'error' as const, message })
            await this.markFailed(reviewId, message)
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
            reviewId
        )
    }

    async streamAnalyzeFromPR(prUrl: string, userId: string, conn: SseConnection, reviewId?: string): Promise<void> {
        this.githubService.assertValidPRUrl(prUrl)

        const { send, startedAt } = conn

        try {
            send({ type: 'start' as const })

            // ── Phase 1: Fetch files and RAG standards in parallel ────────────
            const [standards, files] = await Promise.all([
                this.ragService.retrieveForContext('code review standards best practices', userId),
                this.githubService.fetchPRFiles(prUrl).catch(() => null),
            ])

            // Fallback: if file fetch fails entirely, use old single-agent path
            if (!files || files.length === 0) {
                return this.streamAnalysis(
                    `Please review this GitHub pull request: ${prUrl}`,
                    standards, prUrl, 'PR', userId, conn, reviewId
                )
            }

            // ── Phase 1b: Emit file list for the Data Collection stage ────────
            // Fires before planning so the UI shows "Reading files…" first,
            // then transitions to the Planning stage when cluster_plan arrives.
            send({
                type: 'task_plan' as const,
                tasks: files.map(f => ({
                    id: f.filename,
                    label: f.filename.split('/').pop() ?? f.filename,
                })),
            })
            for (const f of files) {
                const diffLines = f.patch ? f.patch.split('\n').length : 0
                const detail = diffLines > 0
                    ? `+${f.additions} -${f.deletions} · ${diffLines} diff lines`
                    : f.status
                send({ type: 'task_update' as const, taskId: f.filename, status: 'done', detail })
            }

            // ── Phase 2: Plan clusters ────────────────────────────────────────
            // Use lightweight LLM call to plan clusters intelligently.
            // Falls back to single "general" cluster automatically on error.
            const clusters = await planClusters(files, this.aiService.provider)

            // Tell the UI exactly what clusters exist — it renders panels immediately
            send({
                type: 'cluster_plan' as const,
                clusters: clusters.map(c => ({
                    id: c.id,
                    label: c.label,
                    focus: c.focus,
                    files: c.files.map(f => ({
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
                clusters.map(cluster => this.runWorkerAgent(cluster, standards, send))
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
                send({ type: 'error' as const, message: 'All cluster agents failed. Please try again.' })
                if (reviewId) await this.markFailed(reviewId, 'All cluster agents failed')
                return
            }

            // ── Phase 4a: Single-cluster shortcut — skip synthesis ────────────
            // Small PRs (≤3 files) produce one cluster — its review is the final output.
            if (partialReviews.length === 1) {
                const only = partialReviews[0].review
                const merged = { ...only, appliedStandards: standards?.appliedNames }
                send({
                    type: 'complete' as const,
                    review: { ...merged, id: reviewId ?? '' },
                    durationMs: Date.now() - startedAt,
                    stepCount: 1,
                })
                await this.reviewRepository.saveReview(prUrl, 'PR', merged, userId, conn.getTrace(), reviewId)
                return
            }

            // ── Phase 4b: Synthesis agent ─────────────────────────────────────
            // Two-attempt LLM synthesis with a programmatic merge fallback so a
            // parse failure never surfaces as an error to the user.
            const finalReview = await this.synthesizeReview(prUrl, partialReviews, standards)
            const merged = { ...finalReview, appliedStandards: standards?.appliedNames }

            send({
                type: 'complete' as const,
                review: { ...merged, id: reviewId ?? '' },
                durationMs: Date.now() - startedAt,
                stepCount: clusters.length + 1, // workers + synthesis
            })
            await this.reviewRepository.saveReview(prUrl, 'PR', merged, userId, conn.getTrace(), reviewId)

        } catch (err) {
            const message = err instanceof Error ? err.message : 'PR review failed'
            send({ type: 'error' as const, message })
            if (reviewId) {
                await this.markFailed(reviewId, message)
            }
        }
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
                    try { parseReviewText(lastText); return true } catch { /* keep going */ }
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

            const allTexts = [finalText, ...steps.map(s => s.text).reverse()].filter(t => t.trim())
            let review: ReviewData | undefined
            for (const text of allTexts) {
                try { review = parseReviewText(text); break } catch { /* try next */ }
            }

            if (!review) {
                this.logger.error(
                    `Stream: review parsing failed — steps: ${steps.length}, ` +
                    `last text: ${JSON.stringify(finalText.slice(0, 300))}`,
                )
                _send({ type: 'error' as const, message: 'The model did not return a valid review. Please try again.' })
                return
            }

            const merged = { ...review, appliedStandards: standards?.appliedNames }
            _send({
                type: 'complete' as const,
                review: { ...merged, id: reviewId ?? '' },
                durationMs: Date.now() - _startedAt,
                stepCount: getToolCallCount(),
            })
            await this.reviewRepository.saveReview(input, reviewType, merged, userId, conn.getTrace(), reviewId)
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Code review failed.'
            thinking.flushPending()
            _send({ type: 'error' as const, message })
            if (reviewId) {
                await this.markFailed(reviewId, message)
            }
        }
    }

    /** Run one cluster's worker agent, emitting SSE events tagged with clusterId. */
    private async runWorkerAgent(
        cluster: ClusterPlan,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        send: (event: ReviewStreamEvent) => void,
    ): Promise<ReviewData> {
        const workerStart = Date.now()

        const fileSection = cluster.files.map(f => {
            const patch = f.patch
                ? (f.patch.length > MAX_PATCH_CHARS
                    ? f.patch.slice(0, MAX_PATCH_CHARS) + '\n… [diff truncated]'
                    : f.patch)
                : `(no diff — ${f.status})`
            return `### ${f.filename}  [+${f.additions} -${f.deletions}  status: ${f.status}]\n${patch}`
        }).join('\n\n')

        const userMessage =
            `Review the following files from the pull request.\n\n` +
            `Your focus: ${cluster.focus}\n\n` +
            fileSection

        const system = buildWorkerPrompt(cluster.label, cluster.focus, standards?.content)

        const tools = {
            runLinter: createRunLinterTool(({ code, language }) =>
                this.linterService.lint(code, language),
            ),
        }

        const pending = new Map<string, { toolName: string; args: Record<string, unknown>; startedAt: number }>()
        const thinking = new ThinkingStream(
            (event) => send({ ...event, clusterId: cluster.id }),
        )
        const clusterSend = (event: ReviewStreamEvent) =>
            send({ ...event, clusterId: cluster.id } as ReviewStreamEvent)

        const { onChunk, onStepFinish } = this.buildStreamCallbacks(clusterSend, pending, thinking)

        const result = streamText({
            model: this.aiService.defaultModel,
            system,
            messages: [{ role: 'user', content: userMessage }],
            tools,
            temperature: 0.2,
            stopWhen: ({ steps }) => {
                const lastText = steps.at(-1)?.text ?? ''
                try { parseReviewText(lastText); return true } catch { /* keep going */ }
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

        const allTexts = [finalText, ...steps.map(s => s.text).reverse()].filter(t => t.trim())
        let review: ReviewData | undefined
        for (const text of allTexts) {
            try { review = parseReviewText(text); break } catch { /* try next */ }
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
                    pending.set(chunk.toolCallId, { toolName: chunk.toolName, args, startedAt: Date.now() })
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
        partialReviews: Array<{ clusterId: string; label: string; review: ReviewData }>,
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
                system: baseSystem + '\n\nFINAL INSTRUCTION: Your entire response must be ONE JSON object. ' +
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
        partialReviews: Array<{ clusterId: string; label: string; review: ReviewData }>,
    ): ReviewData {
        // Deduplicate issues by type+title+location key
        const seen = new Set<string>()
        const issues = partialReviews
            .flatMap(({ review }) => review.issues)
            .filter(i => {
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
            runLinter: createRunLinterTool(({ code, language }) =>
                this.linterService.lint(code, language),
            ),
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
}
