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
} from '@cra/ai'
import type { ReviewData, PRFile } from '@cra/ai'
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

/** Maximum agent loop steps per review type. CODE allows full investigation; PR streaming is pre-built. */
const AGENT_MAX_STEPS = { CODE: 10, PR: 2 } as const

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

            // ── Phase 1: Fetch file list (includes diff patches) ─────────────
            const [standards, files] = await Promise.all([
                this.ragService.retrieveForContext('code review standards best practices'),
                this.githubService.fetchPRFiles(prUrl).catch(() => null),
            ])

            if (!files || files.length === 0) {
                return this.streamAnalysis(
                    `Please review this GitHub pull request: ${prUrl}`,
                    standards, prUrl, 'PR', res, { send, startedAt },
                )
            }

            // ── Phase 2: Emit task plan + mark all files done (diffs are ready)
            // The patch data already came with fetchPRFiles — no extra API calls needed.
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

            // ── Phase 3: Build prompt using diffs (keeps context well within limits)
            // Full-file content is NOT fetched — diffs contain exactly the changed lines
            // which is what the review needs. 15 files × ~200 diff lines ≈ 15 K tokens total.
            const MAX_PATCH_CHARS = 3_000  // per file — prevents any single huge file from dominating
            const fileSection = files.map(f => {
                const patch = f.patch
                    ? (f.patch.length > MAX_PATCH_CHARS
                        ? f.patch.slice(0, MAX_PATCH_CHARS) + '\n… [diff truncated]'
                        : f.patch)
                    : `(no diff — ${f.status})`
                return `### ${f.filename}  [+${f.additions} -${f.deletions}  status: ${f.status}]\n${patch}`
            }).join('\n\n')

            const userMessage =
                `Please review this GitHub pull request: ${prUrl}\n\n` +
                `The PR has ${files.length} changed file(s). ` +
                `Diffs for all files are provided below.\n\n` +
                fileSection

            // ── Phase 4: AI analysis (no file tools — context is pre-built) ──
            return this.streamAnalysis(
                userMessage, standards, prUrl, 'PR', res, { send, startedAt },
            )
        } catch (err) {
            const message = err instanceof Error ? err.message : 'PR review failed'
            send({ type: 'error', message })
            res.end()
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

    // Extracts ReviewData from the model's text, handling three production failure modes:
    // clean JSON, JSON wrapped in a markdown fence, and JSON embedded in surrounding prose.
    private parseReviewText(text: string): ReviewData {
        const t = text.trim()

        const candidates = [t]

        const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (fenceMatch) candidates.push(fenceMatch[1].trim())

        const start = t.indexOf('{')
        const end = t.lastIndexOf('}')
        if (start !== -1 && end > start) candidates.push(t.slice(start, end + 1))

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
