'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { PageHeader } from '@/components/layout/page-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { historyService } from '@/lib/api'
import { useSession } from 'next-auth/react'
import { HistoryStatsPanel, type Stats } from '@/components/history/history-stats-panel'
import { HistoryReviewList, type ReviewSummary } from '@/components/history/history-review-list'

export default function HistoryPage() {
    const [reviews, setReviews] = useState<ReviewSummary[]>([])
    const [stats, setStats] = useState<Stats | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const { data: session, status } = useSession()
    const githubToken = session?.githubToken

    // Ref holds the pre-delete snapshot so the rollback in handleDelete
    // never captures a stale closure value of `reviews`.
    const rollbackRef = useRef<ReviewSummary[]>([])

    useEffect(() => {
        if (!githubToken) return
        const load = async () => {
            try {
                const [reviewsData, statsData] = await Promise.all([
                    historyService.getReviews<ReviewSummary[]>(githubToken),
                    historyService.getStats<Stats>(githubToken),
                ])
                setReviews(reviewsData)
                setStats(statsData)
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Something went wrong.')
            } finally {
                setIsLoading(false)
            }
        }
        load()
    }, [githubToken])

    const handleDelete = useCallback(async (id: string) => {
        rollbackRef.current = reviews              // capture snapshot before mutation
        setReviews(prev => prev.filter(r => r.id !== id))

        try {
            await historyService.deleteReview(id, githubToken)
            setStats(prev =>
                prev ? { ...prev, totalReviews: Math.max(0, prev.totalReviews - 1) } : prev
            )
        } catch (err) {
            setReviews(rollbackRef.current)
            setError(err instanceof Error ? err.message : 'Failed to delete review.')
        }
    }, [reviews, githubToken])

    if (status === 'loading') {
        return (
            <div className="min-h-screen bg-app-bg text-gray-100">
                <AppHeader />
                <main className="max-w-4xl mx-auto p-6 space-y-6">
                    <div className="h-8 w-48 rounded-lg bg-gray-800 animate-pulse" />
                    <HistoryReviewList reviews={[]} isLoading={true} />
                </main>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-app-bg text-gray-100">
            <AppHeader />

            <main className="max-w-4xl mx-auto p-6 space-y-6">
                <PageHeader
                    icon={History}
                    title="Review History"
                    description="All past code reviews. Click any review to view details and continue the conversation."
                />

                {error && <ErrorBanner message={error} />}

                <HistoryStatsPanel stats={stats} isLoading={isLoading} />
                <HistoryReviewList reviews={reviews} isLoading={isLoading} onDelete={handleDelete} />
            </main>
        </div>
    )
}
