import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import { REVIEW_SYSTEM_PROMPT } from '@cra/ai'
import type { Response } from 'express'

@Injectable()
export class ReviewService {
    private openai

    constructor(private configService: ConfigService) {
        this.openai = createOpenAI({
            apiKey: this.configService.get<string>('OPENAI_API_KEY'),
        })
    }

    async streamReview(code: string, res: Response): Promise<void> {
        const result = streamText({
            model: this.openai('gpt-5-nano-2025-08-07'),
            system: REVIEW_SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: `Please review the following code:\n\n\`\`\`\n${code}\n\`\`\``,
                },
            ],
            temperature: 0.2,
        })

        // Pipe the stream to the HTTP response as SSE
        result.pipeTextStreamToResponse(res)
    }
}