import { Injectable, HttpException, InternalServerErrorException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, Output } from 'ai'
import {
    REVIEW_SYSTEM_PROMPT,
    ReviewDataSchema,
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
        // Pre-run linter on JS/TS before calling the AI — avoids AI SDK multi-step
        // tool calling which is currently incompatible with Output.object in this SDK version.
        const lintContext = await this.tryLint(code)
        return this.runReview({ code, lintContext })
    }

    async analyzeFromPR(prUrl: string): Promise<ReviewData> {
        // Validate URL format before making API calls
        this.githubService.validatePRUrl(prUrl)

        // Pre-fetch the PR diff directly (no tool calling in the agent loop)
        const diff = await this.githubService.fetchPRDiff(prUrl)

        // Attempt to lint JS/TS code found in the diff
        const lintContext = await this.tryLint(diff)

        return this.runReview({ code: diff, lintContext, isDiff: true })
    }

    /**
     * Attempt to run ESLint on the code. Returns a summary string or null if
     * the code is not JS/TS or parsing fails.
     */
    private async tryLint(code: string): Promise<string | null> {
        const isJsTs = /\.(js|ts|jsx|tsx)|\bfunction\b|\bconst\b|\blet\b|\bvar\b|=>/.test(code)
        if (!isJsTs) return null
        try {
            const result = await this.linterService.lint(code, 'javascript')
            return result === 'No lint issues found.' ? null : result
        } catch {
            return null
        }
    }

    private async runReview({
        code,
        lintContext,
        isDiff = false,
    }: {
        code: string
        lintContext: string | null
        isDiff?: boolean
    }): Promise<ReviewData> {
        const codeBlock = isDiff
            ? `\`\`\`diff\n${code}\n\`\`\``
            : `\`\`\`\n${code}\n\`\`\``

        const lintSection = lintContext
            ? `\n\nESLint static analysis found the following issues. Incorporate these into your review:\n${lintContext}`
            : ''

        const userMessage = isDiff
            ? `Please review this GitHub PR diff:${lintSection}\n\n${codeBlock}`
            : `Please review the following code:${lintSection}\n\n${codeBlock}`

        try {
            // Single-step generation — no multi-step tool calling.
            // Pre-processing (PR fetch, linting) is handled above in plain NestJS code.
            const result = await generateText({
                model: this.openai('gpt-4o-mini'),
                // @ts-expect-error TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
                output: Output.object({ schema: ReviewDataSchema }),
                system: REVIEW_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userMessage }],
                temperature: 0.2,
            })

            return result.output as ReviewData
        } catch (err: unknown) {
            if (err instanceof HttpException) throw err
            const cause = (err as { cause?: unknown })?.cause
            if (cause instanceof HttpException) throw cause
            throw new InternalServerErrorException(
                err instanceof Error ? err.message : 'Code review failed. Please try again.',
            )
        }
    }
}