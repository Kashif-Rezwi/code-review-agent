import {
    Injectable,
    HttpException,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs } from 'ai'
import {
    REVIEW_SYSTEM_PROMPT,
    ReviewDataSchema,
    createFetchGithubPRTool,
    createListPRFilesTool,
    createRunLinterTool,
} from '@cra/ai'
import type { ReviewData, PRFile } from '@cra/ai'
import { GithubService } from '../github/github.service'
import { LinterService } from '../linter/linter.service'
import { RagService } from '../rag/rag.service'
import { PrismaService } from '../prisma/prisma.service'

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
        this.githubService.validatePRUrl(prUrl)
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

    private async runAgent(
        userMessage: string,
        standards: Awaited<ReturnType<RagService['retrieveForContext']>>,
        input: string,
        reviewType: 'CODE' | 'PR',
    ): Promise<ReviewData> {
        const system = standards
            ? `${REVIEW_SYSTEM_PROMPT}\n\nYour team's coding standards — apply these during the review:\n\n${standards.content}`
            : REVIEW_SYSTEM_PROMPT

        try {
            const result = await generateText({
                model: this.openai('gpt-4o-mini'),
                system,
                messages: [{ role: 'user', content: userMessage }],
                tools: {
                    fetchGithubPR: createFetchGithubPRTool(async ({ prUrl }) => {
                        try {
                            return await this.githubService.fetchPRDiff(prUrl)
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err)
                            return `[Tool error: ${msg}. Follow the OUTPUT RULE and respond with JSON now.]`
                        }
                    }),
                    listPRFiles: createListPRFilesTool(async ({ prUrl }) => {
                        try {
                            return await this.githubService.fetchPRFiles(prUrl)
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err)
                            return `[Tool error: ${msg}. Use fetchGithubPR as fallback.]` as unknown as PRFile[]
                        }
                    }),
                    runLinter: createRunLinterTool(({ code, language }) =>
                        this.linterService.lint(code, language),
                    ),
                },
                stopWhen: stepCountIs(8),
                temperature: 0.2,
            })

            const review = this.parseReviewText(result.text)
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
