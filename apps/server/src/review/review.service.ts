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

    async analyzeCode(code: string): Promise<ReviewData> {
        const standards = await this.ragService.retrieveForContext(code)
        return this.runAgent(
            `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
            standards,
            code,
            'CODE',
        )
    }

    async analyzeFromPR(prUrl: string): Promise<ReviewData> {
        this.githubService.assertValidPRUrl(prUrl)
        const standards = await this.ragService.retrieveForContext(
            'code review standards best practices',
        )
        return this.runAgent(
            `Please review this GitHub pull request: ${prUrl}`,
            standards,
            prUrl,
            'PR',
        )
    }

    // ── Streaming variants ────────────────────────────────────────────────────
    // These mirror analyzeCode / analyzeFromPR but emit SSE events via `res`
    // instead of returning a Promise<ReviewData>.  The controller injects the
    // raw Express Response so the service can write directly.

    async streamAnalyzeCode(code: string, res: Response): Promise<void> {
        const standards = await this.ragService.retrieveForContext(code)
        return this.streamAnalysis(
            `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
            standards,
            code,
            'CODE',
            res,
        )
    }

    async streamAnalyzeFromPR(prUrl: string, res: Response): Promise<void> {
        this.githubService.assertValidPRUrl(prUrl)

        const { send, startedAt } = initSse(res)

        try {
            send({ type: 'start' })

            // ── Phase 1: Fetch files and RAG standards in parallel ────────────
            const [standards, files] = await Promise.all([
                this.ragService.retrieveForContext('code review standards best practices'),
                this.githubService.fetchPRFiles(prUrl).catch(() => null),
            ])

            // Fallback: if file fetch fails entirely, use old single-agent path
            if (!files || files.length === 0) {
                return this.streamAnalysis(
                    `Please review this GitHub pull request: ${prUrl}`,
                    standards, prUrl, 'PR', res, { send, startedAt },
                )
            }

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
                    fileNames: c.files.map(f => f.filename),
                })),
            })

            // ── Phase 2: Run all worker agents in parallel ────────────────────
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

            // ── Phase 3: Skip synthesis for single-cluster PRs ────────────────
            // Small PRs (≤3 files) produce one cluster — its review is the final output.
            if (partialReviews.length === 1) {
                const only = partialReviews[0].review
                const merged = { ...only, appliedStandards: standards?.appliedNames }
                const id = await this.saveReview(prUrl, 'PR', merged)
                send({
                    type: 'complete',
                    review: { ...merged, id },
                    durationMs: Date.now() - startedAt,
                    stepCount: 1,
                })
                res.end()
                return
            }

            // ── Phase 3: Synthesis agent ──────────────────────────────────────
            // Final LLM call that sees all partial reviews and produces the unified
            // output — including cross-cluster issue detection.
            const synthesisMessage = buildSynthesisUserMessage(prUrl, partialReviews)
            const synthesisSystem = standards
                ? `${buildSynthesisSystemPrompt()}\n\nYour team's coding standards:\n\n${standards.content}`
                : buildSynthesisSystemPrompt()

            const { text: synthesisText } = await generateText({
                model: this.openai('gpt-4o-mini'),
                system: synthesisSystem,
                messages: [{ role: 'user', content: synthesisMessage }],
                temperature: 0.2,
            })

            const finalReview = this.parseReviewText(synthesisText)
            const merged = { ...finalReview, appliedStandards: standards?.appliedNames }
            const id = await this.saveReview(prUrl, 'PR', merged)

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
        const MAX_STEPS = AGENT_MAX_STEPS.CODE

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
            const id = await this.saveReview(input, reviewType, merged)
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
        existingConn?: SseConnection,
    ): Promise<void> {
        let _send: (event: ReviewStreamEvent) => void
        let _startedAt: number

        if (existingConn) {
            // PR path: SSE headers already set by streamAnalyzeFromPR.
            _send = existingConn.send
            _startedAt = existingConn.startedAt
        } else {
            // Code path: initialise SSE headers here and emit the start event.
            const conn = initSse(res)
            _send = conn.send
            _startedAt = conn.startedAt
            _send({ type: 'start' })
        }

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
            const id = await this.saveReview(input, reviewType, merged)
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

        const MAX_PATCH_CHARS = 3_000
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
    ): Promise<string | undefined> {
        if (!this.hasDb) return undefined
        try {
            const saved = await this.prisma.review.create({
                data: {
                    type,
                    input,
                    summary: data.summary,
                    score: data.score,
                    positives: data.positives,
                    appliedStandards: data.appliedStandards ?? [],
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

    // Extracts ReviewData from the model's text, handling four production failure modes:
    // clean JSON, JSON wrapped in a markdown fence, JSON preceded by analysis prose,
    // and JSON embedded anywhere in surrounding prose.
    private parseReviewText(text: string): ReviewData {
        const t = text.trim()

        const candidates = [t]

        // ① Markdown fence
        const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (fenceMatch) candidates.push(fenceMatch[1].trim())

        // ② Last standalone `{` line → last `}` (synthesis agent outputs prose before JSON;
        //   the prose may contain `{...}` fragments which would fool a simple indexOf search.
        //   Using the LAST line-starting `{` reliably finds the JSON block.)
        const lastLineJson = t.lastIndexOf('\n{')
        const jsonBlockStart = lastLineJson !== -1
            ? lastLineJson + 1
            : (t.startsWith('{') ? 0 : -1)
        const jsonBlockEnd = t.lastIndexOf('}')
        if (jsonBlockStart !== -1 && jsonBlockEnd > jsonBlockStart) {
            candidates.push(t.slice(jsonBlockStart, jsonBlockEnd + 1).trim())
        }

        // ③ First `{` → last `}` (legacy fallback)
        const start = t.indexOf('{')
        if (start !== -1 && jsonBlockEnd > start) candidates.push(t.slice(start, jsonBlockEnd + 1))

        for (const candidate of candidates) {
            try {
                return ReviewDataSchema.parse(JSON.parse(candidate))
            } catch { /* try next candidate */ }
        }

        throw new InternalServerErrorException(
            'The model did not return a valid review. Please try again.',
        )
    }
}
