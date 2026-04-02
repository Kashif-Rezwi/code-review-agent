import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel, EmbeddingModel } from 'ai'

@Injectable()
export class AiService {
    private readonly openai: ReturnType<typeof createOpenAI>

    constructor(private readonly config: ConfigService) {
        this.openai = createOpenAI({
            apiKey: this.config.get<string>('OPENAI_API_KEY'),
        })
    }
    
    get defaultModel(): LanguageModel {
        return this.openai('gpt-4o-mini')
    }

    get provider() {
        return this.openai
    }

    get embeddingModel(): EmbeddingModel {
        return this.openai.embedding('text-embedding-3-small')
    }
}
