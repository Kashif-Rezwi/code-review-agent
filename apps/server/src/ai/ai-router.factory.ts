import { createGateway } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

/**
 * Pluggable AI routers — "one API key → many models" broker APIs, selected via AI_ROUTER
 * (one active chat router per process; restart to switch). Chat tiers only: embeddings stay
 * pinned to the Vercel AI Gateway in AiService (OpenRouter has no comparable embedding catalog).
 */

export const AI_ROUTER_NAMES = ['vercel-gateway', 'openrouter'] as const
export type AiRouterName = (typeof AI_ROUTER_NAMES)[number]

/** Minimal chat-model surface every router must expose. */
export interface AiChatRouter {
    languageModel(modelId: string): LanguageModel
}

export type AiRouterKeys = {
    gatewayApiKey?: string
    openrouterApiKey?: string
}

/**
 * Parse the AI_ROUTER env value (case/whitespace-insensitive). Unknown values fail fast
 * at boot — silently defaulting could route paid traffic to the wrong provider.
 */
export function parseAiRouterName(raw: string | undefined): AiRouterName {
    const normalized = raw?.trim().toLowerCase()
    if (!normalized) return 'vercel-gateway'
    if ((AI_ROUTER_NAMES as readonly string[]).includes(normalized)) return normalized as AiRouterName
    throw new Error(`Unknown AI_ROUTER "${raw}" — valid options: ${AI_ROUTER_NAMES.join(', ')}`)
}

/**
 * Build the active chat router. A missing API key warns at boot instead of throwing,
 * so the app still boots for tooling/tests that never call a model.
 */
export function createChatRouter(
    name: AiRouterName,
    keys: AiRouterKeys,
    warn: (message: string) => void,
): AiChatRouter {
    switch (name) {
        case 'openrouter': {
            if (!keys.openrouterApiKey) {
                warn(
                    'AI_ROUTER=openrouter but OPENROUTER_API_KEY is not set — every chat call will fail until it is configured.',
                )
            }
            const client = createOpenRouter({ apiKey: keys.openrouterApiKey })
            return { languageModel: (modelId) => client.chat(modelId) }
        }
        case 'vercel-gateway': {
            const gateway = createGateway({ apiKey: keys.gatewayApiKey })
            return { languageModel: (modelId) => gateway.languageModel(modelId) }
        }
    }
}
