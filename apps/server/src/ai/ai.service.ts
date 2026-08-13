import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createGateway } from 'ai'
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

/**
 * Single provider boundary for every AI call in the app. Everything is routed
 * through the Vercel AI Gateway (`createGateway`), so one API key reaches many
 * providers and model selection is pure configuration.
 *
 * Model tiers are independently configurable via env (`provider/model` gateway IDs):
 *  - review (defaultModel): code review agent, PR cluster workers, synthesis
 *  - fast (fastModel):            PR clustering planner + follow-up chat
 *  - embedding:                   RAG vectors (must stay Gemini 1536-dim space)
 */
@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name)
    private readonly gateway: ReturnType<typeof createGateway>
    private readonly reviewModelId: string
    private readonly fastModelId: string
    private readonly embeddingModelId: string

    constructor(private readonly config: ConfigService) {
        const apiKey = this.config.get<string>('AI_GATEWAY_API_KEY')
        if (!apiKey) {
            this.logger.warn(
                'AI_GATEWAY_API_KEY is not set — every AI call will fail until it is configured.',
            )
        }
        this.gateway = createGateway({ apiKey })

        // Review tier — the quality-critical pipeline (tool-calling, long structured
        // JSON, large patches). Default is the cheapest current-gen Gemini coding model.
        this.reviewModelId = this.config.get<string>('AI_REVIEW_MODEL') ?? 'poolside/laguna-s-2.1-free'
        // Fast tier — light classification (planner) and chat Q&A over a fixed review.
        // Defaults to the cheapest flash-lite tier; independent of the review model.
        this.fastModelId = this.config.get<string>('AI_FAST_MODEL') ?? 'poolside/laguna-s-2.1-free'
        // Embedding tier — MUST remain a Gemini 1536-dim model to match vector(1536) and
        // keep already-embedded RAG documents (same model = same vector space) comparable.
        this.embeddingModelId = this.config.get<string>('AI_EMBEDDING_MODEL') ?? 'google/gemini-embedding-001'
    }

    /** Review tier — the review pipeline (code review, PR workers, synthesis). */
    get defaultModel(): LanguageModel {
        return this.gateway.languageModel(this.reviewModelId)
    }

    /** Fast tier — PR planner + follow-up chat. Cheaper/faster, quality non-critical. */
    get fastModel(): LanguageModel {
        return this.gateway.languageModel(this.fastModelId)
    }

    private get embeddingModel(): EmbeddingModel {
        return this.gateway.embeddingModel(this.embeddingModelId)
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
