export class ThinkingStream {
    // ── Thinking stream state ─────────────────────────────────────────────
    // fullAccumulated: every text-delta received, in order.
    // lastThinkingEnd: index into fullAccumulated up to which we've already
    //   emitted thinking events.  Everything at or after this that relates
    //   to JSON output is permanently suppressed.
    // jsonBoundary: index where the JSON answer starts (-1 until found).
    //   Once jsonBoundary is set, no more thinking events are ever emitted.
    // searchFrom: incremental scan offset — only text appended since the last
    //   check can contain a new boundary (plus a small lookbehind so a boundary
    //   split across two deltas, e.g. `\n` then `{`, is never missed).
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
     * Index where the JSON answer starts, or -1 while still in reasoning territory.
     * Two shapes are recognized:
     *   1. A standalone `{` line outside any code fence (the instructed format).
     *   2. A ``` / ```json fence immediately followed by `{` — fence-wrapping is
     *      common model drift; without it the whole JSON review would stream into
     *      the thinking feed. Fences around non-JSON snippets stay thinking.
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
