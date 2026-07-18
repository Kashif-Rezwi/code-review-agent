import {
    assertExactCoverage,
    buildDeterministicClusters,
    reconcileClusterPlan,
    type PRFile,
} from '@cra/ai'

function file(filename: string, changes = 10): PRFile {
    return {
        filename,
        status: 'modified',
        additions: Math.ceil(changes / 2),
        deletions: Math.floor(changes / 2),
        patch: `@@ -1 +1 @@\n-old\n+${'x'.repeat(changes)}`,
    }
}

describe('coverage-safe cluster planning', () => {
    it('repairs unknown files, duplicate assignments, duplicate IDs and omissions', () => {
        const files = [
            file('src/auth/login.ts'),
            file('src/auth/login.test.ts'),
            file('src/billing/invoice.ts'),
            file('src/billing/tax.ts'),
            file('src/ui/page.tsx'),
            file('src/ui/page.test.tsx'),
        ]

        const result = reconcileClusterPlan(files, [
            {
                id: 'Same ID',
                label: 'Authentication',
                focus: 'Review auth behavior.',
                fileNames: ['src/auth/login.ts', 'src/auth/login.ts', 'not-in-the-pr.ts'],
            },
            {
                id: 'Same ID',
                label: 'Billing',
                focus: 'Review billing behavior.',
                fileNames: ['src/billing/invoice.ts', 'src/auth/login.ts'],
            },
        ])

        assertExactCoverage(files, result)
        expect(new Set(result.map((cluster) => cluster.id)).size).toBe(result.length)
        expect(result.flatMap((cluster) => cluster.files.map((item) => item.filename)).sort()).toEqual(
            files.map((item) => item.filename).sort(),
        )
    })

    it('partitions a 20-file PR exactly once into four balanced fallback clusters', () => {
        const files = Array.from({ length: 20 }, (_, index) =>
            file(`packages/domain-${index % 5}/src/file-${index}.ts`, 10 + index),
        )

        const result = buildDeterministicClusters(files)
        const assignments = result.flatMap((cluster) => cluster.files.map((item) => item.filename))

        expect(result).toHaveLength(4)
        expect(assignments).toHaveLength(20)
        expect(new Set(assignments).size).toBe(20)
        assertExactCoverage(files, result)
    })

    it('keeps a source module and its matching test in the same fallback cluster', () => {
        const files = [
            file('src/auth/session.ts', 80),
            file('src/auth/session.test.ts', 70),
            file('src/billing/invoice.ts', 60),
            file('src/ui/page.tsx', 50),
            file('src/db/query.ts', 40),
            file('src/api/route.ts', 30),
            file('src/cache/store.ts', 20),
        ]

        const result = buildDeterministicClusters(files)
        const sourceCluster = result.find((cluster) => cluster.files.some((item) => item.filename === 'src/auth/session.ts'))

        expect(sourceCluster?.files.map((item) => item.filename)).toContain('src/auth/session.test.ts')
        assertExactCoverage(files, result)
    })
})
