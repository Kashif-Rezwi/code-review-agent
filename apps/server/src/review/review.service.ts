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
        // Pre-run linter to avoid AI SDK v6 multi-step tool bugs with Output.object.
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

    // Lint JS/TS code or PR diffs (checked via headers) to avoid false positives.
    // Returns a summary string, or null if unrecognised or clean.
    private async tryLint(code: string): Promise<string | null> {
        const JS_TS_EXTS = /\.(js|ts|jsx|tsx|mjs|cjs)$/i
        // Detect via diff file headers (PR diffs) or treat as raw JS/TS if no diff headers found
        const diffHeaders = code.match(/^\+\+\+ b\/(.+)$/gm)
        const isJsTs = diffHeaders
            ? diffHeaders.some((h) => JS_TS_EXTS.test(h))
            : JS_TS_EXTS.test(code.split('\n')[0] ?? '') || this.looksLikeJsTs(code)

        if (!isJsTs) return null
        try {
            const result = await this.linterService.lint(code)
            return result === 'No lint issues found.' ? null : result
        } catch {
            return null
        }
    }

    /** Heuristic for raw code (not a diff): look for unambiguous JS/TS patterns. */
    private looksLikeJsTs(code: string): boolean {
        return /\bimport\b.+\bfrom\b|require\s*\(|=>\s*\{/.test(code)
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
            // Single-step generation: PR fetch & linting are pre-processed in NestJS.
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
            // Re-throw intact HttpExceptions; wrap everything else in 500.
            if (err instanceof HttpException) throw err
            const cause = (err as { cause?: unknown })?.cause
            if (cause instanceof HttpException) throw cause
            throw new InternalServerErrorException(
                err instanceof Error ? err.message : 'Code review failed. Please try again.',
            )
        }
    }
}