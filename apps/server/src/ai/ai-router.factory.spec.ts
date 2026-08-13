import { AI_ROUTER_NAMES, createChatRouter, parseAiRouterName } from './ai-router.factory'

const noopWarn = (): void => undefined

/** Runtime model instances carry these; the SDK's LanguageModel union type hides them. */
type ModelHandle = { provider: string }

function handleOf(model: unknown): ModelHandle {
    return model as ModelHandle
}

describe('parseAiRouterName', () => {
    it('defaults to vercel-gateway when AI_ROUTER is unset', () => {
        expect(parseAiRouterName(undefined)).toBe('vercel-gateway')
        expect(parseAiRouterName('')).toBe('vercel-gateway')
    })

    it('accepts every registered router name', () => {
        for (const name of AI_ROUTER_NAMES) {
            expect(parseAiRouterName(name)).toBe(name)
        }
    })

    it('throws on unknown names, listing the valid options', () => {
        expect(() => parseAiRouterName('oppenrouter')).toThrow(
            /Unknown AI_ROUTER "oppenrouter" — valid options: vercel-gateway, openrouter/,
        )
    })

    it('normalizes case and surrounding whitespace', () => {
        expect(parseAiRouterName(' OpenRouter ')).toBe('openrouter')
        expect(parseAiRouterName('VERCEL-GATEWAY')).toBe('vercel-gateway')
    })
})

describe('createChatRouter', () => {
    it('builds vercel-gateway models carrying the gateway provider id', () => {
        const router = createChatRouter('vercel-gateway', { gatewayApiKey: 'test-key' }, noopWarn)
        expect(handleOf(router.languageModel('any/model')).provider).toContain('gateway')
    })

    it('builds openrouter models carrying the openrouter provider id', () => {
        const router = createChatRouter('openrouter', { openrouterApiKey: 'test-key' }, noopWarn)
        expect(handleOf(router.languageModel('any/model')).provider).toContain('openrouter')
    })

    it('warns when openrouter is selected without an API key', () => {
        const warn = jest.fn()
        createChatRouter('openrouter', {}, warn)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('OPENROUTER_API_KEY'))
    })

    it('does not warn when the selected router key is present', () => {
        const warn = jest.fn()
        createChatRouter('openrouter', { openrouterApiKey: 'test-key' }, warn)
        createChatRouter('vercel-gateway', { gatewayApiKey: 'test-key' }, warn)
        expect(warn).not.toHaveBeenCalled()
    })
})
