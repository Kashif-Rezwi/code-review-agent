import { createGateway } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

/**
 * Pluggable AI routers — "one API key → many models" broker APIs. The active
 * router is selected manually via the AI_ROUTER env var (one active chat router
 * per process; restart to switch). Adding a new router = one registry name +
 * one `createChatRouter` case.
 *
 * Routers cover CHAT models only (review + fast tiers). The embedding tier is
 * deliberately pinned to the Vercel AI Gateway in AiService: OpenRouter has no
 * comparable embedding catalog, and swapping embedding models invalidates every
 * stored RAG vector regardless (different vector space).
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
 * Parse the AI_ROUTER env value — case/whitespace-insensitive. Unknown values
 * fail fast at boot with the valid options listed — silently defaulting could
 * route paid traffic to the wrong provider.
 */
export function parseAiRouterName(raw: string | undefined): AiRouterName {
    const normalized = raw?.trim().toLowerCase()
    if (!normalized) return 'vercel-gateway'
    if ((AI_ROUTER_NAMES as readonly string[]).includes(normalized)) return normalized as AiRouterName
    throw new Error(`Unknown AI_ROUTER "${raw}" — valid options: ${AI_ROUTER_NAMES.join(', ')}`)
}

/**
 * Build the active chat router. A missing API key is a boot-time warning, not
 * an exception — matching the historical fail-at-call-time behavior so the app
 * still boots for tooling/tests that never call a model.
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
