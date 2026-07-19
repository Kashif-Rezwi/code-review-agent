import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUnifiedDiff } from './unified-diff.parser'

describe('parseUnifiedDiff', () => {
    const fixture = readFileSync(join(__dirname, '__fixtures__', 'all-file-types.diff'), 'utf8')
    const parsed = parseUnifiedDiff(fixture)

    it('normalizes modified, added, deleted, renamed and binary files', () => {
        expect(parsed.files.map(({ filename, status, patchState }) => ({ filename, status, patchState }))).toEqual([
            { filename: 'src/modified.ts', status: 'modified', patchState: 'full' },
            { filename: 'src/added.ts', status: 'added', patchState: 'full' },
            { filename: 'src/deleted.ts', status: 'removed', patchState: 'full' },
            { filename: 'src/new-name.ts', status: 'renamed', patchState: 'full' },
            { filename: 'assets/logo.png', status: 'added', patchState: 'binary' },
            { filename: 'src/space file.ts', status: 'modified', patchState: 'full' },
        ])
    })

    it('preserves all parsed hunks and rename metadata', () => {
        const modified = parsed.files[0]
        const renamed = parsed.files[3]

        expect(modified.patch).toContain('@@ -1,3 +1,3 @@')
        expect(modified.patch).toContain('@@ -10,2 +10,3 @@')
        expect(renamed.previousFilename).toBe('src/old-name.ts')
        expect(renamed.previous_filename).toBe('src/old-name.ts')
    })

    it('preserves no-newline markers without inventing binary content', () => {
        const spaced = parsed.files.find((file) => file.filename === 'src/space file.ts')
        const binary = parsed.files.find((file) => file.filename === 'assets/logo.png')

        expect(spaced?.patch).toContain('\\ No newline at end of file')
        expect(binary?.patch).toBeUndefined()
        expect(parsed.warnings).toEqual([])
    })
})
