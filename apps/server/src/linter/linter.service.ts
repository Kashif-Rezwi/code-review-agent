import { Injectable } from '@nestjs/common'

@Injectable()
export class LinterService {
    async lint(code: string, language: 'javascript' | 'typescript' = 'javascript'): Promise<string> {
        try {
            const { Linter } = await import('eslint')
            const linter = new Linter()

            const messages = linter.verify(code, {
                parserOptions: {
                    ecmaVersion: 2022,
                    sourceType: 'module',
                    ecmaFeatures: { jsx: true },
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

            if (messages.length === 0) return 'No lint issues found.'

            const formatted = messages
                .slice(0, 20) // cap output — avoids blowing the context window
                .map((m) => {
                    const sev = m.severity === 2 ? 'error' : 'warning'
                    const rule = m.ruleId ? ` (${m.ruleId})` : ''
                    return `Line ${m.line}:${m.column} [${sev}]${rule} — ${m.message}`
                })
                .join('\n')

            return `ESLint found ${messages.length} issue(s):\n${formatted}`
        } catch (err) {
            // Never crash the agent loop — return a safe fallback the model can handle
            const msg = err instanceof Error ? err.message : String(err)
            return `Linter could not parse the code: ${msg}`
        }
    }
}
