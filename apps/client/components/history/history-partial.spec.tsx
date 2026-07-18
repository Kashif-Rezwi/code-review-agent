import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HistoryReviewList } from './history-review-list'
import { HistoryStatsPanel } from './history-stats-panel'

describe('history partial-review UI', () => {
    it('shows a PARTIAL badge and a separate aggregate count', () => {
        render(<>
            <HistoryStatsPanel
                isLoading={false}
                stats={{ totalReviews: 4, partialReviews: 1, issuesByType: [], issuesBySeverity: [] }}
            />
            <HistoryReviewList
                isLoading={false}
                reviews={[{
                    id: 'review-1',
                    type: 'PR',
                    status: 'PARTIAL',
                    summary: 'One cluster was not reviewed.',
                    score: 6,
                    createdAt: '2026-07-18T00:00:00.000Z',
                    _count: { issues: 1 },
                }]}
            />
        </>)

        expect(screen.getByText('PARTIAL')).toBeInTheDocument()
        expect(screen.getByText('1 partial review')).toBeInTheDocument()
    })
})
