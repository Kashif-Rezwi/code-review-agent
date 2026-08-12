import type { LintResult } from '../linter/linter.service'
import { toolDoneLabel } from './review.formatter'

const ARGS = { code: 'var x = 1', language: 'javascript', filename: 'src/app.ts' }

function outcomes(result: LintResult): Map<string, LintResult> {
    return new Map([[ARGS.code, result]])
}

describe('toolDoneLabel — runLinter', () => {
    it('renders the real violation count', () => {
        const label = toolDoneLabel(
            'runLinter',
            ARGS,
            'ESLint found 3 issue(s):…',
            outcomes({ output: '', errors: 1, warnings: 2, parseError: false }),
        )
        expect(label).toBe('app.ts — 3 issues · 9 chars')
    })

    it('renders clean only when ESLint found nothing', () => {
        const label = toolDoneLabel(
            'runLinter',
            ARGS,
            'No lint issues found.',
            outcomes({ output: '', errors: 0, warnings: 0, parseError: false }),
        )
        expect(label).toBe('app.ts — clean · 9 chars')
    })

    it('renders could not parse for parse failures', () => {
        const label = toolDoneLabel(
            'runLinter',
            ARGS,
            'Linter could not parse the code: …',
            outcomes({ output: '', errors: 0, warnings: 0, parseError: true }),
        )
        expect(label).toBe('app.ts — could not parse · 9 chars')
    })

    it('falls back to the language when no filename is provided', () => {
        const args = { code: ARGS.code, language: 'typescript' }
        const label = toolDoneLabel(
            'runLinter',
            args,
            'No lint issues found.',
            outcomes({ output: '', errors: 0, warnings: 0, parseError: false }),
        )
        expect(label).toBe('typescript — clean · 9 chars')
    })

    it('renders a generic label for unknown tools', () => {
        expect(toolDoneLabel('someTool', {}, undefined)).toBe('someTool complete')
    })
})
