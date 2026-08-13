import { Logger } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { AiService } from './ai.service'

/** Runtime model instances carry these; the SDK's LanguageModel union type hides them. */
type ModelHandle = { provider: string; modelId: string }

function handleOf(model: unknown): ModelHandle {
    return model as ModelHandle
}

/** Build AiService with a bare ConfigService stub reading from `env`. */
function buildService(env: Record<string, string>): AiService {
    const config = { get: (key: string) => env[key] } as unknown as ConfigService
    return new AiService(config)
}

/** The embedding getter is private; tests reach it to verify the gateway pin. */
function embeddingProviderOf(service: AiService): string {
    return handleOf((service as unknown as { embeddingModel: unknown }).embeddingModel).provider
}

beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => jest.restoreAllMocks())

describe('AiService router selection', () => {
    it('routes chat tiers through vercel-gateway by default', () => {
        const service = buildService({ AI_GATEWAY_API_KEY: 'test-key' })
        expect(handleOf(service.defaultModel).provider).toContain('gateway')
        expect(handleOf(service.fastModel).provider).toContain('gateway')
        expect(handleOf(service.defaultModel).modelId).toBe('deepseek/deepseek-v4-flash-0731')
    })

    it('routes chat tiers through openrouter when AI_ROUTER=openrouter', () => {
        const service = buildService({
            AI_ROUTER: 'openrouter',
            AI_GATEWAY_API_KEY: 'test-key',
            OPENROUTER_API_KEY: 'test-key',
        })
        expect(handleOf(service.defaultModel).provider).toContain('openrouter')
        expect(handleOf(service.fastModel).provider).toContain('openrouter')
    })

    it('keeps the embedding tier on vercel-gateway regardless of AI_ROUTER', () => {
        const service = buildService({
            AI_ROUTER: 'openrouter',
            AI_GATEWAY_API_KEY: 'test-key',
            OPENROUTER_API_KEY: 'test-key',
        })
        expect(embeddingProviderOf(service)).toContain('gateway')
    })

    it('uses router-specific default model IDs, with env overrides winning', () => {
        const openrouter = buildService({
            AI_ROUTER: 'openrouter',
            AI_GATEWAY_API_KEY: 'test-key',
            OPENROUTER_API_KEY: 'test-key',
        })
        expect(handleOf(openrouter.defaultModel).modelId).toBe('deepseek/deepseek-chat-v3-0324:free')

        const overridden = buildService({
            AI_ROUTER: 'openrouter',
            AI_GATEWAY_API_KEY: 'test-key',
            OPENROUTER_API_KEY: 'test-key',
            AI_REVIEW_MODEL: 'qwen/qwen3-coder:free',
            AI_FAST_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
        })
        expect(handleOf(overridden.defaultModel).modelId).toBe('qwen/qwen3-coder:free')
        expect(handleOf(overridden.fastModel).modelId).toBe('meta-llama/llama-3.3-70b-instruct:free')
    })

    it('fails fast at boot on an unknown AI_ROUTER', () => {
        expect(() => buildService({ AI_ROUTER: 'groq', AI_GATEWAY_API_KEY: 'test-key' })).toThrow(
            /Unknown AI_ROUTER "groq"/,
        )
    })

    it('falls back to router defaults when model env vars are blank (dotenv empty-string trap)', () => {
        const service = buildService({
            AI_ROUTER: 'openrouter',
            AI_GATEWAY_API_KEY: 'test-key',
            OPENROUTER_API_KEY: 'test-key',
            AI_REVIEW_MODEL: '',
            AI_FAST_MODEL: '   ',
        })
        expect(handleOf(service.defaultModel).modelId).toBe('deepseek/deepseek-chat-v3-0324:free')
        expect(handleOf(service.fastModel).modelId).toBe('deepseek/deepseek-chat-v3-0324:free')
    })

    it('warns that only embeddings fail when the gateway key is missing on a non-gateway router', () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
        buildService({ AI_ROUTER: 'openrouter', OPENROUTER_API_KEY: 'test-key' })
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('embedding (RAG) calls will fail'))
    })
})
