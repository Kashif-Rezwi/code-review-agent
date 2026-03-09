import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, Output } from 'ai'
import { REVIEW_SYSTEM_PROMPT, ReviewDataSchema } from '@cra/ai'
import type { ReviewData } from '@cra/ai'

@Injectable()
export class ReviewService {
    private openai

    constructor(private configService: ConfigService) {
        this.openai = createOpenAI({
            apiKey: this.configService.get<string>('OPENAI_API_KEY'),
        })
    }

    async analyzeCode(code: string): Promise<ReviewData> {
        const result = await generateText({
            model: this.openai('gpt-4o-mini'),
            // @ts-expect-error TS2589 — tsc cannot resolve recursive Zod generic depth; runtime is correct
            output: Output.object({ schema: ReviewDataSchema }),
            system: REVIEW_SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: `Please review the following code:\n\`\`\`\n${code}\n\`\`\``,
                },
            ],
            temperature: 0.2,
        })

        return result.output as ReviewData
    }
}