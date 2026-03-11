import { Injectable, HttpException, InternalServerErrorException } from '@nestjs/common'
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
        // Validate URL format eagerly — fail fast before entering the agent loop
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
                    fetchGithubPR: createFetchGithubPRTool(({ prUrl }) =>
                        this.githubService.fetchPRDiff(prUrl),
                    ),
                    runLinter: createRunLinterTool(({ code, language }) =>
                        this.linterService.lint(code, language),
                    ),
                },
                // Budget: fetchGithubPR(1) + runLinter(1) + JSON output(1) + buffer(1) = 4
                stopWhen: stepCountIs(4),
                temperature: 0.2,
            })

            // Manual Zod parsing avoids AI SDK v6 "No output generated" error 
            // when combining Output.object with multi-step tool calls.
            return ReviewDataSchema.parse(JSON.parse(result.text))
        } catch (err: unknown) {
            // Re-throw intact HttpExceptions; wrap everything else in 500.
            if (err instanceof HttpException) throw err
            const cause = (err as { cause?: unknown })?.cause
            if (cause instanceof HttpException) throw cause
            throw new InternalServerErrorException(
                err instanceof Error ? err.message : 'Code review failed.',
            )
        }
    }
}