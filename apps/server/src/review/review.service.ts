import {
    Injectable,
    HttpException,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, streamText } from 'ai'
import { Response } from 'express'
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
import type { Prisma } from '@prisma/client'
import { GithubService } from '../github/github.service'
import { LinterService } from '../linter/linter.service'
import { RagService } from '../rag/rag.service'
import { PrismaService } from '../prisma/prisma.service'
import { initSse, type SseConnection } from './review.sse'
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
    private openai
    private readonly hasDb: boolean

    constructor(
        private config: ConfigService,
        private prisma: PrismaService,
        private githubService: GithubService,
        private linterService: LinterService,
        private ragService: RagService,
    ) {
        this.openai = createOpenAI({
            apiKey: this.config.get<string>('OPENAI_API_KEY'),
        })
        this.hasDb = !!this.config.get('DATABASE_URL')
    }

    async analyzeCode(code: string, userId: string): Promise<ReviewData> {
        const standards = await this.ragService.retrieveForContext(code, userId)
        return this.runAgent(
            `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
            standards,
            code,
            'CODE',
            userId,
        )
    }

    async analyzeFromPR(prUrl: string, userId: string): Promise<ReviewData> {
        this.githubService.assertValidPRUrl(prUrl)
        const standards = await this.ragService.retrieveForContext(
            'code review standards best practices',
            userId,
        )
        return this.runAgent(
            `Please review this GitHub pull request: ${prUrl}`,
            standards,
            prUrl,
            'PR',
            userId,
        )
    }

    // ── Streaming variants ────────────────────────────────────────────────────
    // These mirror analyzeCode / analyzeFromPR but emit SSE events via `res`
    // instead of returning a Promise<ReviewData>.  The controller injects the
    // raw Express Response so the service can write directly.

    async streamAnalyzeCode(code: string, res: Response, userId: string): Promise<void> {
        const standards = await this.ragService.retrieveForContext(code, userId)
        return this.streamAnalysis(
            `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
            standards,
            code,
            'CODE',
            res,
            userId,
        )
    }

    async streamAnalyzeFromPR(prUrl: string, res: Response, userId: string): Promise<void> {
        this.githubService.assertValidPRUrl(prUrl)

        const conn = initSse(res)
        const { send, startedAt } = conn

        try {
            send({ type: 'start' })

            // ── Phase 1: Fetch files and RAG standards in parallel ────────────
            const [standards, files] = await Promise.all([
                this.ragService.retrieveForContext('code review standards best practices', userId),
                this.githubService.fetchPRFiles(prUrl).catch(() => null),
            ])

            // Fallback: if file fetch fails entirely, use old single-agent path
            if (!files || files.length === 0) {
                return this.streamAnalysis(
                    `Please review this GitHub pull request: ${prUrl}`,
                    standards, prUrl, 'PR', res, userId, conn,
                )
            }

            // ── Phase 1b: Emit file list for the Data Collection stage ────────
            // Fires before planning so the UI shows "Reading files…" first,
            // then transitions to the Planning stage when cluster_plan arrives.
            send({
                type: 'task_plan',
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
                send({ type: 'task_update', taskId: f.filename, status: 'done', detail })
            }

            // ── Phase 2: Plan clusters ────────────────────────────────────────
            // Use lightweight LLM call to plan clusters intelligently.
            // Falls back to single "general" cluster automatically on error.
            const clusters = await planClusters(files, this.openai)

            // Tell the UI exactly what clusters exist — it renders panels immediately
            send({
                type: 'cluster_plan',
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
                send({ type: 'error', message: 'All cluster agents failed. Please try again.' })
                res.end()
                return
            }

            // ── Phase 4a: Single-cluster shortcut — skip synthesis ────────────
            // Small PRs (≤3 files) produce one cluster — its review is the final output.
            if (partialReviews.length === 1) {
                const only = partialReviews[0].review
                const merged = { ...only, appliedStandards: standards?.appliedNames }
                const id = await this.saveReview(prUrl, 'PR', merged, userId, conn.getTrace())
                send({
                    type: 'complete',
                    review: { ...merged, id },
                    durationMs: Date.now() - startedAt,
                    stepCount: 1,
                })
                res.end()
                return
            }

            // ── Phase 4b: Synthesis agent ─────────────────────────────────────
            // Two-attempt LLM synthesis with a programmatic merge fallback so a
            // parse failure never surfaces as an error to the user.
            const finalReview = await this.synthesizeReview(prUrl, partialReviews, standards)
            const merged = { ...finalReview, appliedStandards: standards?.appliedNames }
            const id = await this.saveReview(prUrl, 'PR', merged, userId, conn.getTrace())

            send({
                type: 'complete',
                review: { ...merged, id },
                durationMs: Date.now() - startedAt,
                stepCount: clusters.length + 1, // workers + synthesis
            })

        } catch (err) {
            const message = err instanceof Error ? err.message : 'PR review failed'
            send({ type: 'error', message })
        } finally {
            // Guard against double-end: the fallback streamAnalysis path ends res itself.
            if (!res.writableEnded) res.end()
        }
    }



    private async runAgent(
        userMessage: string,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        input: string,
        reviewType: 'CODE' | 'PR',
        userId: string,
    ): Promise<ReviewData> {
        const system = standards
            ? `${buildSystemPrompt(reviewType)}\n\nYour team's coding standards — apply these during the review:\n\n${standards.content}`
            : buildSystemPrompt(reviewType)

        // Step budget:
        //   code review                → runLinter(1) + JSON(1) = 2
        //   PR review                  → listPRFiles(1) + JSON(1) = 2
        //   PR + investigation (×3)    → listPRFiles(1) + fetchFileContent(1-3) + JSON(1) = 3-5
        //   PR fallback + investigate  → listPRFiles(1) + fetchGithubPR(1) + fetchFileContent(1-3) + JSON(1) = 4-6
        //   worst-case autonomous max  → 8 tool calls + forced JSON(1) = 9  (+1 buffer = 10)
        const MAX_STEPS = AGENT_MAX_STEPS[reviewType]

        try {
            const result = await generateText({
                model: this.openai('gpt-4o-mini'),
                system,
                messages: [{ role: 'user', content: userMessage }],
                tools: this.buildAgentTools(reviewType),
                temperature: 0.2,

                // Exit the loop the moment a step produces a parseable review.
                // Falls back to the hard cap so the loop always terminates.
                stopWhen: ({ steps }) => {
                    const lastText = steps.at(-1)?.text ?? ''
                    try { this.parseReviewText(lastText); return true } catch { /* keep going */ }
                    return steps.length >= MAX_STEPS
                },

                // On the last allowed step, remove tools entirely so the model
                // is physically unable to make another tool call — it must respond
                // with text (i.e. the JSON review).
                prepareStep: ({ steps }) => {
                    if (steps.length >= MAX_STEPS - 1) return { toolChoice: 'none' as const }
                    return {}
                },
            })

            // With the two guards above result.text should always contain the JSON.
            // The step scan is a final paranoia safety net for unexpected model behaviour.
            const allTexts = [result.text, ...result.steps.map(s => s.text).reverse()]
                .filter(t => t.trim())

            let review: ReviewData | undefined
            for (const text of allTexts) {
                try { review = this.parseReviewText(text); break } catch { /* try next */ }
            }

            if (!review) {
                this.logger.error(
                    `Review parsing failed — steps: ${result.steps.length}, ` +
                    `last text: ${JSON.stringify(result.text.slice(0, 300))}`,
                )
                throw new InternalServerErrorException(
                    'The model did not return a valid review. Please try again.',
                )
            }

            const merged = { ...review, appliedStandards: standards?.appliedNames }
            const id = await this.saveReview(input, reviewType, merged, userId)
            return { ...merged, id }
        } catch (err: unknown) {
            if (err instanceof HttpException) throw err
            const cause = (err as { cause?: unknown })?.cause
            if (cause instanceof HttpException) throw cause
            throw new InternalServerErrorException(
                err instanceof Error ? err.message : 'Code review failed.',
            )
        }
    }

    /** SSE-only AI streaming phase — runs the model and emits thinking/tool/complete events.
     *  Pass `existingConn` when SSE headers are already set (PR path); omit for fresh setup. */
    private async streamAnalysis(
        userMessage: string,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        input: string,
        reviewType: 'CODE' | 'PR',
        res: Response,
        userId: string,
        existingConn?: SseConnection,
    ): Promise<void> {
        let _conn: SseConnection

        if (existingConn) {
            // PR path: SSE headers already set by streamAnalyzeFromPR.
            _conn = existingConn
        } else {
            // Code path: initialise SSE headers here and emit the start event.
            _conn = initSse(res)
            _conn.send({ type: 'start' })
        }

        const _send = _conn.send
        const _startedAt = _conn.startedAt

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
                model: this.openai('gpt-4o-mini'),
                system,
                messages: [{ role: 'user', content: userMessage }],
                // PR path: NO tools — context is fully pre-built from diffs. Giving the
                // model tools in this path causes it to run runLinter on every file.
                // Code path: linter only.
                ...(reviewType === 'CODE' && { tools: this.buildAgentTools('CODE') }),
                temperature: 0.2,

                stopWhen: ({ steps }) => {
                    const lastText = steps.at(-1)?.text ?? ''
                    try { this.parseReviewText(lastText); return true } catch { /* keep going */ }
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
                try { review = this.parseReviewText(text); break } catch { /* try next */ }
            }

            if (!review) {
                this.logger.error(
                    `Stream: review parsing failed — steps: ${steps.length}, ` +
                    `last text: ${JSON.stringify(finalText.slice(0, 300))}`,
                )
                _send({ type: 'error', message: 'The model did not return a valid review. Please try again.' })
                return
            }

            const merged = { ...review, appliedStandards: standards?.appliedNames }
            const id = await this.saveReview(input, reviewType, merged, userId, _conn.getTrace())
            _send({
                type: 'complete',
                review: { ...merged, id },
                durationMs: Date.now() - _startedAt,
                stepCount: getToolCallCount(),
            })
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Code review failed.'
            thinking.flushPending()
            _send({ type: 'error', message })
        } finally {
            res.end()
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
            model: this.openai('gpt-4o-mini'),
            system,
            messages: [{ role: 'user', content: userMessage }],
            tools,
            temperature: 0.2,
            stopWhen: ({ steps }) => {
                const lastText = steps.at(-1)?.text ?? ''
                try { this.parseReviewText(lastText); return true } catch { /* keep going */ }
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
            try { review = this.parseReviewText(text); break } catch { /* try next */ }
        }

        if (!review) {
            throw new Error(`Worker agent for cluster "${cluster.id}" did not return a valid review.`)
        }

        send({
            type: 'cluster_done',
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
                        type: 'tool_start',
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
                        type: 'tool_done',
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
                model: this.openai('gpt-4o-mini'),
                system: baseSystem,
                messages: [{ role: 'user', content: userMessage }],
                temperature: 0.2,
            })
            return this.parseReviewText(text)
        } catch (err) {
            this.logger.warn(`Synthesis attempt 1 failed: ${err instanceof Error ? err.message : err}`)
        }

        // ── Attempt 2: temperature 0 + reinforced JSON-only instruction ───────
        try {
            const { text } = await generateText({
                model: this.openai('gpt-4o-mini'),
                system: baseSystem + '\n\nFINAL INSTRUCTION: Your entire response must be ONE JSON object. ' +
                    'Start with a line containing only { and end with a line containing only }. ' +
                    'Absolutely no text before or after the JSON.',
                messages: [{ role: 'user', content: userMessage }],
                temperature: 0,
            })
            return this.parseReviewText(text)
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

    private async saveReview(
        input: string,
        type: 'CODE' | 'PR',
        data: ReviewData,
        userId: string,
        traceLog?: ReviewStreamEvent[],
    ): Promise<string | undefined> {
        if (!this.hasDb) return undefined
        try {
            const saved = await this.prisma.review.create({
                data: {
                    userId,
                    type,
                    input,
                    summary: data.summary,
                    score: data.score,
                    positives: data.positives,
                    appliedStandards: data.appliedStandards ?? [],
                    ...(traceLog && traceLog.length > 0
                        ? { traceLog: traceLog as unknown as Prisma.InputJsonValue }
                        : {}),
                    issues: {
                        create: data.issues.map((i) => ({
                            type: i.type,
                            severity: i.severity,
                            title: i.title,
                            location: i.location,
                            description: i.description,
                            recommendation: i.recommendation,
                        })),
                    },
                },
            })
            return saved.id
        } catch (err) {
            this.logger.warn(
                `Failed to save review: ${err instanceof Error ? err.message : err}`,
            )
            return undefined
        }
    }

    /**
     * Extract ReviewData from the model's text output.
     *
     * Handles five real-world failure modes in priority order:
     *   ① Clean JSON (most common — workers and synthesis under normal conditions)
     *   ② Markdown-fenced JSON  (``` json … ```)
     *   ③ Balanced-brace extraction from every line-boundary `{` — handles prose before JSON
     *      AND prose after JSON (the `lastIndexOf('}')` strategy breaks when the model
     *      appends trailing commentary containing `}` characters)
     *   ④ First `{` to matching balanced `}` — final safety net for inline JSON
     *
     * Throws only if all candidates fail Zod validation — the caller should then retry.
     */
    private parseReviewText(text: string): ReviewData {
        const t = text.trim()

        const candidates: string[] = [t]

        // ① Markdown fence — strip code fences the model adds despite instructions
        const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (fenceMatch) candidates.push(fenceMatch[1].trim())

        // ② & ③ All line-boundary `{` positions (last to first) using balanced extraction.
        //   Processing last-to-first ensures we try the most recent JSON block first,
        //   which is correct when the model outputs analysis prose before the JSON object.
        const starts: number[] = []
        if (t.startsWith('{')) starts.push(0)
        let pos = 0
        while ((pos = t.indexOf('\n{', pos)) !== -1) { starts.push(pos + 1); pos++ }

        for (let i = starts.length - 1; i >= 0; i--) {
            const end = this.findBalancedBraceEnd(t, starts[i])
            if (end !== -1) candidates.push(t.slice(starts[i], end + 1))
        }

        // ④ First `{` to its balanced `}` — handles JSON not at a line boundary
        const firstBrace = t.indexOf('{')
        if (firstBrace !== -1) {
            const end = this.findBalancedBraceEnd(t, firstBrace)
            if (end !== -1) candidates.push(t.slice(firstBrace, end + 1))
        }

        for (const candidate of candidates) {
            try {
                return ReviewDataSchema.parse(JSON.parse(candidate))
            } catch { /* try next candidate */ }
        }

        throw new InternalServerErrorException(
            'The model did not return a valid review. Please try again.',
        )
    }

    /**
     * Walk `text` from `start` (which must be `{`) to find its balanced closing `}`.
     * Correctly skips `{` and `}` characters inside JSON string values.
     * Returns the index of the closing `}`, or -1 if the braces are unbalanced.
     */
    private findBalancedBraceEnd(text: string, start: number): number {
        let depth = 0
        let inString = false
        let escape = false

        for (let i = start; i < text.length; i++) {
            const ch = text[i]
            if (escape) { escape = false; continue }
            if (ch === '\\' && inString) { escape = true; continue }
            if (ch === '"') { inString = !inString; continue }
            if (inString) { continue }
            if (ch === '{') { depth++ }
            else if (ch === '}') { if (--depth === 0) return i }
        }
        return -1
    }
}
