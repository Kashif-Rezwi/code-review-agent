import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClusterState } from '@/lib/use-review-stream'
import { ReviewProgress } from './review-progress'

describe('ReviewProgress', () => {
    it('renders planner, failed workers and partial synthesis from cluster state even without task updates', () => {
        const clusters = new Map<string, ClusterState>([
            ['cluster-a', {
                id: 'cluster-a',
                label: 'API',
                focus: 'Review API changes.',
                files: [{ name: 'src/a.ts', additions: 2, deletions: 1, status: 'modified' }],
                traceEntries: [],
                issueCount: 1,
                done: true,
            }],
            ['cluster-b', {
                id: 'cluster-b',
                label: 'UI',
                focus: 'Review UI changes.',
                files: [{ name: 'src/b.tsx', additions: 3, deletions: 0, status: 'modified' }],
                traceEntries: [],
                done: true,
                failed: true,
                attempts: 2,
            }],
        ])

        render(
            <ReviewProgress
                entries={[]}
                taskItems={[]}
                phase="complete"
                clusterMap={clusters}
                mode="pr"
                outcome="partial"
                synthesisStarted
            />,
        )

        expect(screen.getByText('Planning')).toBeInTheDocument()
        expect(screen.getByText('Distributed 2 files across 2 clusters')).toBeInTheDocument()
        expect(screen.getByText('Failed after retry')).toBeInTheDocument()
        expect(screen.getByText('Synthesis')).toBeInTheDocument()
    })
})
