import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createGateway } from 'ai'
import type { LanguageModel, EmbeddingModel } from 'ai'
import { runEmbedDocuments, runEmbedQuery } from './ai-runtime.adapter'
import { createChatRouter, parseAiRouterName } from './ai-router.factory'
import type { AiChatRouter, AiRouterName } from './ai-router.factory'
import { withProviderRetry } from './provider-backoff'

/**
 * MUST match the pgvector column (`embedding vector(1536)`). gemini-embedding-001 emits 3072 dims natively;
 * we truncate per call — cosine distance (<=>) is magnitude-invariant, so no extra normalization is needed.
 */
export const EMBEDDING_DIMENSIONS = 1536

/**
 * Default chat model IDs per router (that router's catalog naming), both free tiers. OpenRouter's free
 * catalog rotates — override via AI_REVIEW_MODEL / AI_FAST_MODEL when a default disappears.
 */
const DEFAULT_CHAT_MODEL_IDS: Record<AiRouterName, { review: string; fast: string }> = {
    'vercel-gateway': { review: 'deepseek/deepseek-v4-flash-0731', fast: 'deepseek/deepseek-v4-flash-0731' },
    openrouter: { review: 'deepseek/deepseek-chat-v3-0324:free', fast: 'deepseek/deepseek-chat-v3-0324:free' },
}

/** Resolve an env-provided model ID, falling back on blank values — dotenv parses `AI_REVIEW_MODEL=` as an empty string, which `??` would not catch. */
function modelIdFromEnv(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim()
    return trimmed ? trimmed : fallback
}

/**
 * Single provider boundary for every AI call. Chat models route through the AI_ROUTER-selected
 * router (one API key → many providers); embeddings stay pinned to the Vercel AI Gateway (must
 * remain Gemini 1536-dim to match stored RAG vectors), so AI_GATEWAY_API_KEY is always required.
 */
@Injectable()
export class AiService {
    private readonly logger = new Logger(AiService.name)
    private readonly chatRouter: AiChatRouter
    private readonly embeddingGateway: ReturnType<typeof createGateway>
    private readonly reviewModelId: string
    private readonly fastModelId: string
    private readonly embeddingModelId: string

    constructor(private readonly config: ConfigService) {
        const gatewayApiKey = this.config.get<string>('AI_GATEWAY_API_KEY')
        const routerName = parseAiRouterName(this.config.get<string>('AI_ROUTER'))
        if (!gatewayApiKey) {
            this.logger.warn(
                routerName === 'vercel-gateway'
                    ? 'AI_GATEWAY_API_KEY is not set — every AI call will fail until it is configured.'
                    : 'AI_GATEWAY_API_KEY is not set — embedding (RAG) calls will fail until it is configured.',
            )
        }

        this.chatRouter = createChatRouter(
            routerName,
            { gatewayApiKey, openrouterApiKey: this.config.get<string>('OPENROUTER_API_KEY') },
            (message) => this.logger.warn(message),
        )
        this.embeddingGateway = createGateway({ apiKey: gatewayApiKey })

        const defaults = DEFAULT_CHAT_MODEL_IDS[routerName]
        // Review tier — quality-critical (tool-calling, long structured JSON, large patches).
        this.reviewModelId = modelIdFromEnv(this.config.get<string>('AI_REVIEW_MODEL'), defaults.review)
        // Fast tier — light classification (planner) and chat Q&A over a fixed review.
        this.fastModelId = modelIdFromEnv(this.config.get<string>('AI_FAST_MODEL'), defaults.fast)
        // Embedding tier — pinned to Gemini 1536-dim so stored RAG vectors stay comparable.
        this.embeddingModelId = modelIdFromEnv(this.config.get<string>('AI_EMBEDDING_MODEL'), 'google/gemini-embedding-001')

        this.logger.log(
            `AI router: ${routerName} (review=${this.reviewModelId}, fast=${this.fastModelId}, embedding=${this.embeddingModelId} via vercel-gateway)`,
        )
    }

    /** Review tier — the review pipeline (code review, PR workers, synthesis). */
    get defaultModel(): LanguageModel {
        return this.chatRouter.languageModel(this.reviewModelId)
    }

    /** Fast tier — PR planner + follow-up chat. Cheaper/faster, quality non-critical. */
    get fastModel(): LanguageModel {
        return this.chatRouter.languageModel(this.fastModelId)
    }

    private get embeddingModel(): EmbeddingModel {
        return this.embeddingGateway.embeddingModel(this.embeddingModelId)
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
