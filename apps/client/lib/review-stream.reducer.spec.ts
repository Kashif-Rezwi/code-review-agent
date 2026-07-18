import { describe, expect, it } from 'vitest'
import type { ReviewData } from '@/types/review.types'
import { initialReviewStreamState, reviewStreamReducer } from './review-stream.reducer'

const review: ReviewData = {
    summary: 'One cluster could not be reviewed.',
    score: 7,
    issues: [],
    positives: [],
    coverage: {
        totalFiles: 2,
        assignedFiles: 2,
        reviewedFiles: 1,
        truncatedFiles: [],
        metadataOnlyFiles: [],
        unreviewedFiles: ['src/b.ts'],
        failedClusters: ['cluster-b'],
        acquisitionSource: 'public_diff',
    },
}

describe('reviewStreamReducer', () => {
    it('buffers cluster-scoped events and replays them after the plan arrives', () => {
        let state = reviewStreamReducer(initialReviewStreamState, {
            type: 'EVENT',
            event: { type: 'thinking', clusterId: 'cluster-b', text: 'Retrying worker' },
            thinkingSeqId: 1,
        })
        state = reviewStreamReducer(state, {
            type: 'EVENT',
            event: {
                type: 'cluster_failed',
                clusterId: 'cluster-b',
                attempts: 2,
                message: 'Worker failed after retry.',
                durationMs: 1200,
            },
        })

        expect(state.pendingClusterEvents.get('cluster-b')).toHaveLength(2)

        state = reviewStreamReducer(state, {
            type: 'EVENT',
            event: {
                type: 'cluster_plan',
                clusters: [{
                    id: 'cluster-b',
                    label: 'Billing',
                    focus: 'Review billing.',
                    files: [{ name: 'src/b.ts', additions: 1, deletions: 1, status: 'modified' }],
                }],
            },
        })

        expect(state.pendingClusterEvents.size).toBe(0)
        expect(state.clusterMap.get('cluster-b')).toMatchObject({
            failed: true,
            done: true,
            attempts: 2,
            error: 'Worker failed after retry.',
        })
        expect(state.clusterMap.get('cluster-b')?.traceEntries).toEqual([
            expect.objectContaining({ kind: 'thinking', text: 'Retrying worker' }),
        ])
    })

    it('stores acquisition warnings, synthesis state and partial outcome', () => {
        let state = reviewStreamReducer(initialReviewStreamState, {
            type: 'EVENT',
            event: {
                type: 'acquisition',
                source: 'public_diff',
                fileCount: 2,
                complete: true,
                warnings: ['GitHub files API was unavailable.'],
            },
        })
        state = reviewStreamReducer(state, {
            type: 'EVENT',
            event: { type: 'synthesis_start', clusterCount: 1 },
        })
        state = reviewStreamReducer(state, {
            type: 'EVENT',
            event: { type: 'complete', review, durationMs: 1500, stepCount: 2, outcome: 'partial' },
        })

        expect(state.acquisition).toMatchObject({ source: 'public_diff', fileCount: 2 })
        expect(state.synthesisStarted).toBe(true)
        expect(state.outcome).toBe('partial')
        expect(state.phase).toBe('complete')
        expect(state.review?.coverage?.unreviewedFiles).toEqual(['src/b.ts'])
    })
})
