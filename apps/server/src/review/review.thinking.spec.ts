import { ThinkingStream } from './review.thinking'

function collect() {
    const events: string[] = []
    const stream = new ThinkingStream((event) => events.push(event.text))
    return { stream, events }
}

describe('ThinkingStream', () => {
    it('emits reasoning and suppresses a standalone-brace JSON answer', () => {
        const { stream, events } = collect()
        stream.onDelta('Checking the fallback path: it looks correct.\n')
        stream.onDelta('{\n  "summary": "ok",\n  "score": 8\n}')
        stream.onDelta('\nTrailing prose after the answer.')

        expect(events).toHaveLength(1)
        expect(events[0]).toContain('fallback path')
        expect(events.join('')).not.toContain('"summary"')
    })

    it('suppresses fence-wrapped JSON instead of leaking it into the thinking feed', () => {
        const { stream, events } = collect()
        stream.onDelta('The change looks safe overall.\n')
        stream.onDelta('```json\n{\n  "summary": "ok",\n  "score": 8,\n  "issues": [],\n  "positives": []\n}\n```')
        stream.onDelta('\nAnything after the fence.')

        expect(events).toHaveLength(1)
        expect(events[0]).toContain('safe overall')
        expect(events.join('')).not.toContain('"summary"')
        expect(events.join('')).not.toContain('```')
    })

    it('keeps non-JSON code fences in the thinking feed', () => {
        const { stream, events } = collect()
        stream.onDelta('Consider this pattern carefully:\n```ts\nconst x = f()\n```\nIt looks fine.\n')

        expect(events.join('')).toContain('const x = f()')
    })

    it('still finds a boundary split across two deltas', () => {
        const { stream, events } = collect()
        stream.onDelta('Wrapping up the analysis now.\n')
        stream.onDelta('\n')
        stream.onDelta('{ "summary": "ok" }')

        expect(events).toHaveLength(1)
        expect(events[0]).toContain('Wrapping up')
        expect(events.join('')).not.toContain('"summary"')
    })
})