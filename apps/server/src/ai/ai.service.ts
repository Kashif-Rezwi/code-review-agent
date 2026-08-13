import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel, EmbeddingModel } from 'ai'
import { runEmbedDocuments, runEmbedQuery } from './ai-runtime.adapter'
import { withProviderRetry } from './provider-backoff'

/**
 * Embedding output dimensionality — MUST stay in sync with the pgvector column
 * (`embedding vector(1536)` in prisma/schema.prisma). gemini-embedding-001 natively
 * emits 3072 dims; we request a 1536-dim truncation per call (see rag.service.ts).
 * Retrieval uses cosine distance (<=>), which is magnitude-invariant, so the
 * truncation needs no extra normalization handling on our side.
 */
export const EMBEDDING_DIMENSIONS = 1536

@Injectable()
export class AiService {
    private readonly google: ReturnType<typeof createGoogleGenerativeAI>
    private readonly chatModelId: string
    private readonly embeddingModelId: string

    constructor(private readonly config: ConfigService) {
        // Google AI Studio key — the free tier needs no billing and covers
        // chat (tool calling + structured output) and embeddings alike.
        this.google = createGoogleGenerativeAI({
            apiKey: this.config.get<string>('GOOGLE_GENERATIVE_AI_API_KEY'),
        })
        // gemini-3.5-flash: stable, free-tier eligible, coding/agentic-focused.
        // The 2.5 generation family is retired for new API keys (generateContent
        // 404s "no longer available to new users"); Pro models have no free quota.
        this.chatModelId = this.config.get<string>('AI_CHAT_MODEL') ?? 'gemini-3.5-flash'
        this.embeddingModelId = this.config.get<string>('AI_EMBEDDING_MODEL') ?? 'gemini-embedding-001'
    }

    get defaultModel(): LanguageModel {
        return this.google(this.chatModelId)
    }

    private get embeddingModel(): EmbeddingModel {
        return this.google.embedding(this.embeddingModelId)
    }

    /**
     * Embed a retrieval query — task-typed and truncated to the pgvector column
     * width. One retry on transient provider errors (429/5xx); callers degrade
     * gracefully when the call still fails.
     */
    embedQuery(text: string): Promise<number[]> {
        return withProviderRetry(
            () => runEmbedQuery(this.embeddingModel, text, {
                google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: 'RETRIEVAL_QUERY' },
            }),
            { label: 'Embedding query' },
        )
    }

    /** Embed document chunks for ingestion — same dimensions/task typing as queries. */
    embedDocuments(chunks: string[]): Promise<number[][]> {
        return withProviderRetry(
            () => runEmbedDocuments(this.embeddingModel, chunks, {
                google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: 'RETRIEVAL_DOCUMENT' },
            }),
            { label: 'Document embedding' },
        )
    }
}
