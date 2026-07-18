import { describe, expect, it } from 'vitest'
import type { ReviewStreamEvent } from '@/types/review.types'
import { parseTraceLog } from './use-trace-replay'

describe('parseTraceLog', () => {
    it('derives PR replay mode from persisted type and preserves partial completion', () => {
        const trace: ReviewStreamEvent[] = [
            { type: 'start' },
            {
                type: 'acquisition',
                source: 'public_diff',
                fileCount: 1,
                complete: true,
                warnings: [],
            },
            {
                type: 'complete',
                durationMs: 100,
                stepCount: 1,
                outcome: 'partial',
                review: {
                    summary: 'Partial result',
                    score: 6,
                    issues: [],
                    positives: [],
                },
            },
        ]

        const replay = parseTraceLog(trace, 'PR')

        expect(replay.mode).toBe('pr')
        expect(replay.outcome).toBe('partial')
        expect(replay.acquisition?.source).toBe('public_diff')
    })

    it('keeps PR mode for historical rows without a trace', () => {
        expect(parseTraceLog(null, 'PR').mode).toBe('pr')
        expect(parseTraceLog([], 'CODE').mode).toBe('code')
    })
})
