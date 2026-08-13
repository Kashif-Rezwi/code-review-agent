import { LinterService } from './linter.service'

describe('LinterService', () => {
    const service = new LinterService()

    it('returns zero counts for clean code', async () => {
        await expect(service.lint('const add = (a, b) => a + b\nadd(1, 2)\n', 'javascript')).resolves.toEqual({
            output: 'No lint issues found.',
            errors: 0,
            warnings: 0,
            parseError: false,
        })
    })

    it('counts errors and warnings separately', async () => {
        const result = await service.lint('var x = 1\neval("2")\n', 'javascript')
        expect(result).toMatchObject({ errors: 1, warnings: 2, parseError: false })
        expect(result.output).toMatch(/^ESLint found 3 issue\(s\):/)
    })

    it('flags fatal parser messages as parseError, not violations', async () => {
        const result = await service.lint('const x = {', 'javascript')
        expect(result).toMatchObject({ errors: 0, warnings: 0, parseError: true })
        expect(result.output).toContain('Parsing error')
    })

    it('does not flag ambient globals like console as undefined', async () => {
        const result = await service.lint('console.log(String(1))\n', 'javascript')
        expect(result).toEqual({ output: 'No lint issues found.', errors: 0, warnings: 0, parseError: false })
    })

    it('parses TypeScript via @typescript-eslint/parser when language is typescript', async () => {
        const result = await service.lint(
            'interface Foo { a: string }\nconst x: Foo = { a: String(1) }\nexport { x }\n',
            'typescript',
        )
        expect(result).toEqual({ output: 'No lint issues found.', errors: 0, warnings: 0, parseError: false })
    })

    it('counts violations in TypeScript code the same as JavaScript', async () => {
        const result = await service.lint('var y = 1\neval(String(2))\n', 'typescript')
        expect(result).toMatchObject({ errors: 1, warnings: 2, parseError: false })
    })
})
