import { AiService } from '../ai/ai.service'
import { runChatStream } from '../ai/ai-runtime.adapter'
import { HistoryRepository } from './history.repository'
import { HistoryService } from './history.service'

// Only the stream factory is mocked; the real adapter's error normalizers run.
jest.mock('../ai/ai-runtime.adapter', () => ({
    ...jest.requireActual('../ai/ai-runtime.adapter'),
    runChatStream: jest.fn(),
}))

const runChatStreamMock = jest.mocked(runChatStream)

function review() {
    return {
        id: 'review-1',
        userId: 'user-1',
        type: 'CODE',
        input: 'const a = 1',
        summary: 'Safe change',
        score: 8,
        issues: [],
        conversations: [],
    }
}

function createHarness() {
    const historyRepository = {
        getReview: jest.fn().mockResolvedValue(review()),
        saveChatQuery: jest.fn().mockResolvedValue(undefined),
    }
    const service = new HistoryService(
        historyRepository as unknown as HistoryRepository,
        { defaultModel: { modelId: 'test-model' } } as unknown as AiService,
    )
    return { service, historyRepository }
}

async function drain(stream: AsyncGenerator<string>): Promise<string[]> {
    const chunks: string[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
}

/** Array-backed async iterable — avoids generator lint rules for trivial streams. */
function textStreamOf(chunks: string[]): AsyncIterable<string> {
    let index = 0
    return {
        [Symbol.asyncIterator]: () => ({
            next: () => {
                const value = chunks[index++]
                return Promise.resolve(
                    value === undefined
                        ? { done: true as const, value: undefined }
                        : { done: false as const, value },
                )
            },
        }),
    }
}

describe('HistoryService.chatGenerator', () => {
    beforeEach(() => runChatStreamMock.mockReset())

    it('streams chunks and persists the completed answer', async () => {
        const { service, historyRepository } = createHarness()
        runChatStreamMock.mockReturnValue({
            textStream: textStreamOf(['Hello', ' there']),
        } as never)

        const chunks = await drain(service.chatGenerator('review-1', 'user-1', 'Hi'))

        expect(chunks).toEqual(['Hello', ' there'])
        expect(historyRepository.saveChatQuery).toHaveBeenCalledWith('review-1', 'Hi', 'Hello there')
    })

    it('throws a captured provider stream error instead of saving a blank answer', async () => {
        const { service, historyRepository } = createHarness()
        runChatStreamMock.mockImplementation((options) => {
            ;(options.onError as (arg: { error: unknown }) => void)({
                error: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },
            })
            // Provider failed — the stream resolves empty.
            return { textStream: textStreamOf([]) } as never
        })

        await expect(drain(service.chatGenerator('review-1', 'user-1', 'Hi')))
            .rejects.toThrow(/AI provider stream error/)
        expect(historyRepository.saveChatQuery).not.toHaveBeenCalled()
    })

    it('does not persist a partial answer when the client disconnects', async () => {
        const { service, historyRepository } = createHarness()
        const controller = new AbortController()
        runChatStreamMock.mockReturnValue({
            textStream: (async function* () {
                await Promise.resolve()
                yield 'partial'
                controller.abort()
            })(),
        } as never)

        const chunks = await drain(service.chatGenerator('review-1', 'user-1', 'Hi', controller.signal))

        expect(chunks).toEqual(['partial'])
        expect(historyRepository.saveChatQuery).not.toHaveBeenCalled()
    })
})