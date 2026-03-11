import {
    Injectable,
    HttpException,
    InternalServerErrorException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs } from 'ai'
import {
    REVIEW_SYSTEM_PROMPT,
    ReviewDataSchema,
    createFetchGithubPRTool,
    createRunLinterTool,
} from '@cra/ai'
import type { ReviewData } from '@cra/ai'
import { GithubService } from '../github/github.service'
import { LinterService } from '../linter/linter.service'

@Injectable()
export class ReviewService {
    private openai

    constructor(
        private config: ConfigService,
        private githubService: GithubService,
        private linterService: LinterService,
    ) {
        this.openai = createOpenAI({
            apiKey: this.config.get<string>('OPENAI_API_KEY'),
        })
    }

    async analyzeCode(code: string): Promise<ReviewData> {
        return this.runAgent(
            `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
        )
    }

    async analyzeFromPR(prUrl: string): Promise<ReviewData> {
        this.githubService.validatePRUrl(prUrl)
        return this.runAgent(`Please review this GitHub pull request: ${prUrl}`)
    }

    private async runAgent(userMessage: string): Promise<ReviewData> {
        try {
            const result = await generateText({
                model: this.openai('gpt-4o-mini'),
                system: REVIEW_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userMessage }],
                tools: {
                    fetchGithubPR: createFetchGithubPRTool(async ({ prUrl }) => {
                        try {
                            return await this.githubService.fetchPRDiff(prUrl)
                        } catch (err) {
                            // Return error as a string rather than throwing — AI SDK v6
                            // passes thrown tool errors back to the model as a result,
                            // which causes it to respond in prose instead of JSON.
                            const msg = err instanceof Error ? err.message : String(err)
                            return `[Tool error: ${msg}. Follow the OUTPUT RULE and respond with JSON now.]`
                        }
                    }),
                    runLinter: createRunLinterTool(({ code, language }) =>
                        this.linterService.lint(code, language),
                    ),
                },
                stopWhen: stepCountIs(4),
                temperature: 0.2,
            })

            return this.parseReviewText(result.text)
        } catch (err: unknown) {
            if (err instanceof HttpException) throw err
            const cause = (err as { cause?: unknown })?.cause
            if (cause instanceof HttpException) throw cause
            throw new InternalServerErrorException(
                err instanceof Error ? err.message : 'Code review failed.',
            )
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
