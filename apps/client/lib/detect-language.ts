/**
 * Detects the programming language of a code snippet heuristically.
 * Returns a Monaco-compatible language identifier.
 */
export function detectLanguage(code: string): string {
    if (!code.trim()) return 'plaintext'

    // TypeScript — must be before JavaScript
    if (
        /:\s*(string|number|boolean|void|null|undefined|any|unknown|never)\b/.test(code) ||
        /\binterface\b|\btype\s+\w+\s*=/.test(code) ||
        /\b(as|satisfies|keyof|typeof|infer|readonly)\b/.test(code)
    ) return 'typescript'

    // JavaScript
    if (
        /\b(const|let|var|function|=>|require|module\.exports|import|export)\b/.test(code)
    ) return 'javascript'

    // Python
    if (
        /\bdef\s+\w+\s*\(|^\s*import\s+\w+|^\s*from\s+\w+\s+import/m.test(code) ||
        /:\s*$/.test(code)
    ) return 'python'

    // Java / Kotlin
    if (/\bpublic\s+(class|static|void)\b/.test(code)) return 'java'

    // Go
    if (/\bfunc\s+\w+\s*\(|package\s+\w+/.test(code)) return 'go'

    // Rust
    if (/\bfn\s+\w+\s*\(|let mut\b/.test(code)) return 'rust'

    // HTML
    if (/<html|<div|<!DOCTYPE/i.test(code)) return 'html'

    // CSS / SCSS
    if (/[.#]\w+\s*\{|@media|@import/.test(code)) return 'css'

    // SQL
    if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|FROM|WHERE)\b/i.test(code)) return 'sql'

    // JSON
    try {
        if (code.trim().startsWith('{') || code.trim().startsWith('[')) {
            JSON.parse(code)
            return 'json'
        }
    } catch { /* not valid JSON */ }

    // Shell / Bash
    if (/^#!/.test(code) || /\b(echo|grep|awk|sed|chmod|sudo)\b/.test(code)) return 'shell'

    return 'plaintext'
}

/**
 * Estimates token count (rough: ~4 chars per token for code)
 */
export function estimateTokens(code: string): number {
    return Math.ceil(code.length / 4)
}
