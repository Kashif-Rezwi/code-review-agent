/**
 * Consume a Server-Sent Events stream and call onEvent for each parsed event.
 * Throws on network errors; caller is responsible for handling AbortError separately.
 *
 * @param reader  The raw byte reader from response.body.getReader()
 * @param onEvent Called once per successfully parsed SSE event
 */
export async function consumeSSEStream<T>(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (event: T) => void,
): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
            // Pick the last `data: ` line in each SSE block (spec-compliant multi-line events).
            const dataLine = part.trim().split('\n').findLast(l => l.startsWith('data: '))
            if (!dataLine) continue
            try { onEvent(JSON.parse(dataLine.slice(6)) as T) }
            catch { /* malformed event — skip */ }
        }
    }
}
