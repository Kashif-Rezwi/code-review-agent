import type { LintResult } from '../linter/linter.service'

// ── Arg parsing helpers ───────────────────────────────────────────────────────
// The AI SDK may deliver args as a parsed object, a JSON string, or undefined
// depending on the SDK version and callback (onChunk vs onStepFinish).

export function parseArgs(raw: unknown): Record<string, unknown> {
    if (!raw) return {}
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>
            }
        } catch { /* not JSON — ignore */ }
    }
    return {}
}

/** Pick the first args object that has actual keys (non-empty). */
export function pickArgs(...candidates: Record<string, unknown>[]): Record<string, unknown> {
    for (const c of candidates) {
        if (Object.keys(c).length > 0) return c
    }
    return {}
}

// ── Human-readable SSE label helpers ─────────────────────────────────────────

export function toolStartLabel(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
        case 'runLinter': {
            const name = (args.filename as string | undefined)?.split('/').pop()
            return name ? `${name}…` : 'Analysing…'
        }
        default: return `Calling ${toolName}…`
    }
}

export function toolStartDetail(_toolName: string, _args: Record<string, unknown>): string | undefined {
    void _toolName
    void _args
    return undefined
}

export function toolDoneLabel(
    toolName: string,
    args: Record<string, unknown>,
    _result: unknown,
    lintOutcomes?: Map<string, LintResult>,
): string {
    void _result
    switch (toolName) {
        case 'runLinter': {
            const name = (args.filename as string | undefined)?.split('/').pop()
            const lang = (args.language as string | undefined) ?? 'unknown'
            const chars = typeof args.code === 'string' ? args.code.length : 0
            const outcome = typeof args.code === 'string' ? lintOutcomes?.get(args.code) : undefined
            const total = (outcome?.errors ?? 0) + (outcome?.warnings ?? 0)
            const status = outcome?.parseError
                ? 'could not parse'
                : !outcome || total === 0
                  ? 'clean'
                  : `${total} issue${total !== 1 ? 's' : ''}`
            const file = name ?? lang
            return `${file} — ${status} · ${chars} chars`
        }
        default: return `${toolName} complete`
    }
}

export function toolDoneDetail(
    toolName: string,
    _args: Record<string, unknown>,
    _result: unknown,
): string | undefined {
    void _args
    void _result
    switch (toolName) {
        case 'runLinter': return undefined
        default: return undefined
    }
}
