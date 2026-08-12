import { Injectable } from '@nestjs/common'

export interface LintResult {
    /** Exact text handed to the model — this wording is part of the model surface. */
    output: string
    errors: number
    warnings: number
    /** True when the code could not be parsed at all (fatal parser message or exception). */
    parseError: boolean
}

@Injectable()
export class LinterService {
    async lint(code: string, _language: 'javascript' | 'typescript' = 'javascript'): Promise<LintResult> {
        void _language
        try {
            const { Linter } = await import('eslint')
            const linter = new Linter()

            const messages = linter.verify(code, {
                languageOptions: {
                    ecmaVersion: 2022,
                    sourceType: 'module',
                    parserOptions: { ecmaFeatures: { jsx: true } },
                },
                rules: {
                    // Correctness
                    'no-unused-vars': 'warn',
                    'no-undef': 'error',
                    'eqeqeq': ['error', 'always'],
                    // Security
                    'no-eval': 'error',
                    'no-implied-eval': 'error',
                    'no-new-func': 'error',
                    'no-script-url': 'error',
                    // Best practices
                    'no-var': 'warn',
                    'prefer-const': 'warn',
                    'no-duplicate-imports': 'error',
                },
            })

            if (messages.length === 0) {
                return { output: 'No lint issues found.', errors: 0, warnings: 0, parseError: false }
            }

            const formatted = messages
                .slice(0, 20) // cap output — avoids blowing the context window
                .map((m) => {
                    const sev = m.severity === 2 ? 'error' : 'warning'
                    const rule = m.ruleId ? ` (${m.ruleId})` : ''
                    return `Line ${m.line}:${m.column} [${sev}]${rule} — ${m.message}`
                })
                .join('\n')

            const output = `ESLint found ${messages.length} issue(s):\n${formatted}`

            // A fatal message means the parser bailed (e.g. TypeScript-only syntax) —
            // that is a parse failure, not a lint violation count.
            if (messages.some((m) => m.fatal)) {
                return { output, errors: 0, warnings: 0, parseError: true }
            }

            const errors = messages.filter((m) => m.severity === 2).length
            return { output, errors, warnings: messages.length - errors, parseError: false }
        } catch (err) {
            // Never crash the agent loop — return a safe fallback the model can handle
            const msg = err instanceof Error ? err.message : String(err)
            return { output: `Linter could not parse the code: ${msg}`, errors: 0, warnings: 0, parseError: true }
        }
    }
}
