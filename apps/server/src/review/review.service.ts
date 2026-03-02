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
            model: this.openai('gpt-4o-mini'),
            system: REVIEW_SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: `Please review the following code:\n\n\`\`\`\n${code}\n\`\`\``,
                },
            ],
            temperature: 0.2,
        })

        // Write headers required by the AI SDK data stream protocol
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('X-Vercel-AI-Data-Stream', 'v1')
        res.setHeader('Transfer-Encoding', 'chunked')

        // Stream each text chunk in the AI SDK data stream format: "0:{json}\n"
        for await (const chunk of result.textStream) {
            res.write(`0:${JSON.stringify(chunk)}\n`)
        }

        res.end()
    }
}