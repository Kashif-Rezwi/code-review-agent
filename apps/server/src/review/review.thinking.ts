export class ThinkingStream {
    // ── Thinking stream state ─────────────────────────────────────────────
    // fullAccumulated: every text-delta received, in order.
    // lastThinkingEnd: index into fullAccumulated up to which we've already
    //   emitted thinking events.  Everything at or after this that relates
    //   to JSON output is permanently suppressed.
    // jsonBoundary: index of the first standalone `{` line (-1 until found).
    // Once jsonBoundary is set, no more thinking events are ever emitted.
    private fullAccumulated = ''
    private lastThinkingEnd = 0
    private jsonBoundary = -1

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

        // Locate the first standalone `{` line in the full accumulated text.
        // Matches: text starting with { OR a newline immediately before {
        // This is searched on the FULL string (not just the rolling buffer)
        // so we never miss it due to buffer resets.
        // Guard: skip if the `{` falls inside a markdown code fence.
        const match = this.fullAccumulated.search(/(?:^|\n)\s*\{/)
        if (match !== -1 && !this.isInsideCodeFence(this.fullAccumulated, match)) {
            this.jsonBoundary = match
            // Emit any reasoning text that arrived before the JSON boundary.
            const finalReasoning = this.fullAccumulated.slice(this.lastThinkingEnd, match)
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
}
