// ── Arg parsing helpers ───────────────────────────────────────────────────────
// The AI SDK may deliver args as a parsed object, a JSON string, or undefined
// depending on the SDK version and callback (onChunk vs onStepFinish).

export function parseArgs(raw: unknown): Record<string, unknown> {
    if (!raw) return {}
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw)
            if (typeof parsed === 'object' && parsed !== null) return parsed
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

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract "owner/repo#number" from a GitHub PR URL, or undefined if no match. */
function prSlug(url: string): string | undefined {
    const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
    return m ? `${m[1]}#${m[2]}` : undefined
}

// ── Human-readable SSE label helpers ─────────────────────────────────────────

export function toolStartLabel(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
        case 'listPRFiles': return 'Listing changed files…'
        case 'fetchGithubPR': return 'Fetching PR diff…'
        case 'fetchFileContent': {
            const fp = (args.filePath as string | undefined) ?? ''
            const name = fp.split('/').pop() || fp
            return name ? `Investigating ${name}…` : 'Investigating file…'
        }
        case 'runLinter': return 'Running linter…'
        default: return `Calling ${toolName}…`
    }
}

export function toolStartDetail(toolName: string, args: Record<string, unknown>): string | undefined {
    switch (toolName) {
        case 'listPRFiles':
        case 'fetchGithubPR': {
            const url = (args.prUrl as string | undefined) ?? ''
            return prSlug(url)
        }
        case 'fetchFileContent': {
            return (args.filePath as string | undefined) ?? undefined
        }
        case 'runLinter': {
            const lang = (args.language as string | undefined) ?? 'unknown'
            const len = typeof args.code === 'string' ? args.code.length : 0
            return `${lang} · ${len} chars`
        }
        default: return undefined
    }
}

export function toolDoneLabel(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
): string {
    switch (toolName) {
        case 'listPRFiles': {
            if (!Array.isArray(result)) return 'PR file list unavailable — using fallback'
            const n = result.length
            return `Found ${n} changed file${n !== 1 ? 's' : ''}`
        }
        case 'fetchGithubPR': {
            if (typeof result === 'string' && result.startsWith('[Tool error:')) return 'PR diff fetch failed'
            return 'PR diff fetched'
        }
        case 'fetchFileContent': {
            const fp = (args.filePath as string | undefined) ?? ''
            const name = fp.split('/').pop() || fp
            if (typeof result === 'string' && result.startsWith('[Tool error:')) {
                return `Could not read ${name || 'file'}`
            }
            return name ? `Read ${name}` : 'File content fetched'
        }
        case 'runLinter': return 'Linter complete'
        default: return `${toolName} complete`
    }
}

export function toolDoneDetail(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
): string | undefined {
    switch (toolName) {
        case 'listPRFiles': {
            if (!Array.isArray(result)) {
                // Extract the human-readable error from the tool's error string.
                if (typeof result === 'string') {
                    const m = result.match(/\[Tool error:\s*([^\]]+)/)
                    return m ? m[1].trim() : result.slice(0, 100)
                }
                return undefined
            }
            const files = result as { filename?: string }[]
            const names = files.map(f => {
                const fp = f.filename ?? '?'
                return fp.split('/').pop() || fp
            })
            if (names.length <= 3) return names.join(', ')
            return `${names.slice(0, 3).join(', ')} (+${names.length - 3} more)`
        }
        case 'fetchGithubPR': {
            if (typeof result !== 'string') return undefined
            if (result.startsWith('[Tool error:')) {
                const m = result.match(/\[Tool error:\s*([^\]]+)/)
                return m ? m[1].trim() : undefined
            }
            const lines = result.split('\n').length
            return `${lines} lines of diff`
        }
        case 'fetchFileContent': {
            if (typeof result !== 'string') return undefined
            const filePath = (args.filePath as string | undefined) ?? ''
            if (result.startsWith('[Tool error:')) {
                const m = result.match(/\[Tool error:\s*([^\]]+)/)
                return filePath
                    ? `${filePath} — ${m ? m[1].trim() : 'fetch error'}`
                    : m ? m[1].trim() : 'Fetch failed'
            }
            const lines = result.split('\n').length
            const kb = (result.length / 1024).toFixed(1)
            return filePath
                ? `${filePath} · ${lines} lines · ${kb} KB`
                : `${lines} lines · ${kb} KB`
        }
        case 'runLinter': {
            if (!result || typeof result !== 'object') return undefined
            const r = result as { errors?: unknown[]; warnings?: unknown[] }
            const errs = r.errors?.length ?? 0
            const warns = r.warnings?.length ?? 0
            if (errs === 0 && warns === 0) return 'No issues found'
            return `${errs} error${errs !== 1 ? 's' : ''}, ${warns} warning${warns !== 1 ? 's' : ''}`
        }
        default: return undefined
    }
}
