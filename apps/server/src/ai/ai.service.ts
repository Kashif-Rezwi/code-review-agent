import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createGateway } from 'ai'
import type { LanguageModel, EmbeddingModel } from 'ai'
import { runEmbedDocuments, runEmbedQuery } from './ai-runtime.adapter'
import { createChatRouter, parseAiRouterName } from './ai-router.factory'
import type { AiChatRouter, AiRouterName } from './ai-router.factory'
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
 * Default chat model IDs per router, in that router's own catalog naming.
 * Both default to free tiers. OpenRouter's free catalog rotates — check
 * https://openrouter.ai/models?q=free and override via AI_REVIEW_MODEL /
 * AI_FAST_MODEL when a default disappears.
 */
const DEFAULT_CHAT_MODEL_IDS: Record<AiRouterName, { review: string; fast: string }> = {
    'vercel-gateway': { review: 'deepseek/deepseek-v4-flash-0731', fast: 'deepseek/deepseek-v4-flash-0731' },
    openrouter: { review: 'deepseek/deepseek-chat-v3-0324:free', fast: 'deepseek/deepseek-chat-v3-0324:free' },
}

/**
 * Resolve an env-provided model ID. dotenv parses `AI_REVIEW_MODEL=` (no value)
 * as an EMPTY string, which `??` would not catch — an empty model ID fails
 * every call with an opaque provider error, so fall back on blank values.
 */
function modelIdFromEnv(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim()
    return trimmed ? trimmed : fallback
}

/**
 * Single provider boundary for every AI call in the app. Chat tiers are routed
 * through the AI router selected via AI_ROUTER (see ai-router.factory.ts) — one
 * API key reaches many providers and model selection is pure configuration.
 *
 * Model tiers are independently configurable via env (model IDs in the active
 * router's catalog naming):
 *  - review (defaultModel): code review agent, PR cluster workers, synthesis
 *  - fast (fastModel):            PR clustering planner + follow-up chat
 *  - embedding:                   RAG vectors — ALWAYS on the Vercel AI Gateway
 *                                 regardless of AI_ROUTER (must stay Gemini
 *                                 1536-dim space; OpenRouter has no comparable
 *                                 embedding catalog), so AI_GATEWAY_API_KEY is
 *                                 required in every configuration.
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
        // Review tier — the quality-critical pipeline (tool-calling, long structured
        // JSON, large patches).
        this.reviewModelId = modelIdFromEnv(this.config.get<string>('AI_REVIEW_MODEL'), defaults.review)
        // Fast tier — light classification (planner) and chat Q&A over a fixed review.
        this.fastModelId = modelIdFromEnv(this.config.get<string>('AI_FAST_MODEL'), defaults.fast)
        // Embedding tier — MUST remain a Gemini 1536-dim model to match vector(1536) and
        // keep already-embedded RAG documents (same model = same vector space) comparable.
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
