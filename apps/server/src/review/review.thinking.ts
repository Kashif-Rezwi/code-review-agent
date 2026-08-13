export class ThinkingStream {
    // ── Thinking stream state ─────────────────────────────────────────────
    // Thinking events cover fullAccumulated up to lastThinkingEnd; once jsonBoundary is found,
    // everything from it on is permanently suppressed. searchFrom is an incremental scan offset
    // (with a small lookbehind so a boundary split across two deltas, e.g. `\n` then `{`, isn't missed).
    private fullAccumulated = ''
    private lastThinkingEnd = 0
    private jsonBoundary = -1
    private searchFrom = 0

    private static readonly LOOKBEHIND = 16

    constructor(private readonly send: (event: { type: 'thinking'; text: string }) => void) { }

    /** Returns true if `pos` falls inside an unclosed triple-backtick code fence.
     *  Prevents false-positive JSON boundary detection on `{` inside code blocks. */
    private isInsideCodeFence(text: string, pos: number): boolean {
        const before = text.slice(0, pos)
        return ((before.match(/```/g) ?? []).length % 2) === 1
    }

    /** Call this before showing a tool step to flush any complete reasoning thus far. */
    public flushPending(): void {
        if (this.jsonBoundary === -1 && this.lastThinkingEnd < this.fullAccumulated.length) {
            const rest = this.fullAccumulated.slice(this.lastThinkingEnd)
            if (rest.trim()) this.send({ type: 'thinking', text: rest })
            this.lastThinkingEnd = this.fullAccumulated.length
        }
    }

    /** Process an incoming text delta from the AI stream. */
    public onDelta(textDelta: string): void {
        this.fullAccumulated += textDelta

        // Once we've found the JSON boundary, ignore all further deltas.
        if (this.jsonBoundary !== -1) return

        const boundary = this.findBoundary()
        if (boundary !== -1) {
            this.jsonBoundary = boundary
            // Emit any reasoning text that arrived before the JSON boundary.
            const finalReasoning = this.fullAccumulated.slice(this.lastThinkingEnd, boundary)
            if (finalReasoning.trim()) this.send({ type: 'thinking', text: finalReasoning })
            this.lastThinkingEnd = this.fullAccumulated.length // nothing more to emit
            return
        }

        // Still in reasoning territory — emit live in sentence-sized chunks.
        const pending = this.fullAccumulated.slice(this.lastThinkingEnd)
        const endsPhrase = /[.!?,;:\n]$/.test(pending.trimEnd())
        if (pending.trim().length >= 20 && endsPhrase) {
            this.send({ type: 'thinking', text: pending })
            this.lastThinkingEnd = this.fullAccumulated.length
        }
    }

    /**
     * Index where the JSON answer starts, or -1 while still in reasoning territory. Recognizes a
     * standalone `{` line outside code fences, or a ``` / ```json fence immediately followed by `{`
     * (common model drift — without it the whole JSON review would stream into the thinking feed).
     */
    private findBoundary(): number {
        const from = Math.max(0, this.searchFrom - ThinkingStream.LOOKBEHIND)
        this.searchFrom = this.fullAccumulated.length
        const window = this.fullAccumulated.slice(from)

        const bare = window.search(/(?:^|\n)\s*\{/)
        if (bare !== -1) {
            const absolute = from + bare
            if (!this.isInsideCodeFence(this.fullAccumulated, absolute)) return absolute
        }

        const fenced = /(?:^|\n)```(?:json)?[ \t]*\r?\n\s*\{/.exec(window)
        if (fenced) return from + fenced.index

        return -1
    }
}
