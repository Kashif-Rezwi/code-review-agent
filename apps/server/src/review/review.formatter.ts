import type { LintResult } from '../linter/linter.service'

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
