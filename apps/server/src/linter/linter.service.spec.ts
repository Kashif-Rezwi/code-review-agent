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

    it('flags TypeScript-only syntax as parseError (espree cannot parse it)', async () => {
        const result = await service.lint('interface Foo { a: string }\n', 'typescript')
        expect(result).toMatchObject({ errors: 0, warnings: 0, parseError: true })
    })
})
