export interface ParsedSSEEvent<T> {
    id?: string
    event: T
}

/** Parse one SSE frame, including standard multiline data concatenation. */
export function parseSSEFrame<T>(frame: string): ParsedSSEEvent<T> | undefined {
    const data: string[] = []
    let id: string | undefined

    for (const rawLine of frame.replace(/\r\n?/g, '\n').split('\n')) {
        if (!rawLine || rawLine.startsWith(':')) continue
        const colon = rawLine.indexOf(':')
        const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
        let value = colon === -1 ? '' : rawLine.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') data.push(value)
        if (field === 'id' && !value.includes('\0')) id = value
    }

    if (data.length === 0) return undefined
    try {
        return { id, event: JSON.parse(data.join('\n')) as T }
    } catch {
        return undefined
    }
}

export async function consumeSSEStream<T>(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (event: ParsedSSEEvent<T>) => void,
): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    const drain = (includeRemainder = false) => {
        buffer = buffer.replace(/\r\n?/g, '\n')
        const frames = buffer.split('\n\n')
        buffer = includeRemainder ? '' : (frames.pop() ?? '')
        if (includeRemainder && frames.at(-1) === '') frames.pop()
        for (const frame of frames) {
            const parsed = parseSSEFrame<T>(frame)
            if (parsed) onEvent(parsed)
        }
    }

    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        drain()
    }
    buffer += decoder.decode()
    if (buffer.trim()) drain(true)
}
