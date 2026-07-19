import { describe, expect, it } from 'vitest'
import { consumeSSEStream, parseSSEFrame } from './sse'

describe('SSE parsing', () => {
    it('returns Stream IDs and concatenates multiline data fields', () => {
        expect(parseSSEFrame<{ message: string }>([
            'id: 123-4',
            'event: thinking',
            'data: {"message":',
            'data: "hello"}',
        ].join('\n'))).toEqual({ id: '123-4', event: { message: 'hello' } })
    })

    it('parses frames split across arbitrary network chunks', async () => {
        const encoder = new TextEncoder()
        const chunks = ['id: 1-0\ndata: {"type":"sta', 'rt"}\n\nid: 2-0\ndata: {"type":"heartbeat"}\n\n']
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
                controller.close()
            },
        })
        const events: unknown[] = []
        await consumeSSEStream(stream.getReader(), (event) => events.push(event))
        expect(events).toEqual([
            { id: '1-0', event: { type: 'start' } },
            { id: '2-0', event: { type: 'heartbeat' } },
        ])
    })
})
