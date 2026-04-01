'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Code2, GitPullRequest, History } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { PageHeader } from '@/components/layout/page-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { ScoreBadge } from '@/components/review/score-badge'
import { Badge } from '@/components/ui/badge'
import { apiFetch } from '@/lib/api'
import { TYPE_CONFIG } from '@/types/review-config'
import { useSession } from 'next-auth/react'

interface ReviewSummary {
    id: string
    type: 'CODE' | 'PR'
    summary: string
    score: number
    createdAt: string
    _count: { issues: number }
}

interface Stats {
    totalReviews: number
    issuesByType: Array<{ type: string; count: number }>
    issuesBySeverity: Array<{ severity: string; count: number }>
}

export default function HistoryPage() {
    const [reviews, setReviews] = useState<ReviewSummary[]>([])
    const [stats, setStats] = useState<Stats | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const { data: session, status } = useSession()
    const githubToken = session?.githubToken

    useEffect(() => {
        if (!githubToken) return
        const load = async () => {
            try {
                const [reviewsData, statsData] = await Promise.all([
                    apiFetch<ReviewSummary[]>('/history', undefined, githubToken),
                    apiFetch<Stats>('/history/stats', undefined, githubToken),
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

    if (status === 'loading') {
        return (
            <div className="min-h-screen bg-app-bg text-gray-100">
                <AppHeader />
                <main className="max-w-4xl mx-auto p-6 space-y-6">
                    <div className="h-8 w-48 rounded-lg bg-gray-800 animate-pulse" />
                    <div className="space-y-2">
                        {[1, 2, 3].map(n => (
                            <div key={n} className="rounded-lg border border-gray-800 bg-gray-900/40 h-16 animate-pulse" />
                        ))}
                    </div>
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

                {/* Issue trends — skeleton while loading, real card once data arrives */}
                {isLoading ? (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 animate-pulse space-y-3">
                        <div className="flex items-center justify-between">
                            <div className="h-3 w-24 rounded bg-gray-700" />
                            <div className="h-3 w-20 rounded bg-gray-800" />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {[72, 56, 80, 64, 60].map((w, i) => (
                                <div key={i} className="h-6 rounded-full bg-gray-800" style={{ width: w }} />
                            ))}
                        </div>
                    </div>
                ) : stats && stats.totalReviews > 0 && (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Issue Trends
                            </span>
                            <span className="text-xs text-gray-500">
                                {stats.totalReviews} review{stats.totalReviews !== 1 ? 's' : ''} total
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {stats.issuesByType.length === 0 ? (
                                <span className="text-xs text-gray-600">No issues recorded yet.</span>
                            ) : (
                                stats.issuesByType.map(({ type, count }) => {
                                    const cfg = TYPE_CONFIG[type as keyof typeof TYPE_CONFIG]
                                    const Icon = cfg?.icon
                                    return (
                                        <div
                                            key={type}
                                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-900/60 border border-gray-800 text-xs text-gray-400"
                                        >
                                            {Icon && <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />}
                                            <span className="capitalize">{type}</span>
                                            <span className="text-gray-500">×{count}</span>
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </div>
                )}

                {/* Review list */}
                {isLoading ? (
                    <div className="space-y-2">
                        {[1, 2, 3, 4, 5].map((n) => (
                            <div key={n} className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 animate-pulse">
                                <div className="flex items-start justify-between gap-4">
                                    {/* Score badge + type badge */}
                                    <div className="flex items-center gap-2 shrink-0">
                                        <div className="h-5 w-11 rounded-full bg-gray-700" />
                                        <div className="h-5 w-14 rounded-full bg-gray-800" />
                                    </div>
                                    {/* Summary text lines */}
                                    <div className="flex-1 space-y-2 min-w-0 pt-0.5">
                                        <div className="h-3 bg-gray-700 rounded w-full" />
                                        <div className="h-3 bg-gray-800 rounded w-4/5" />
                                    </div>
                                    {/* Date + issue count */}
                                    <div className="shrink-0 space-y-1.5 text-right">
                                        <div className="h-3 bg-gray-800 rounded w-20" />
                                        <div className="h-3 bg-gray-800 rounded w-14 ml-auto" />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : reviews.length === 0 ? (
                    <div className="rounded-lg border border-gray-800 bg-gray-900/30 p-10 text-center">
                        <History className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                        <p className="text-gray-500 text-sm">No reviews yet.</p>
                        <p className="text-gray-600 text-xs mt-1">
                            Submit your first code review to see it here.
                        </p>
                        <Link
                            href="/review"
                            className="inline-block mt-4 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                            Start a review →
                        </Link>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {reviews.map((review) => (
                            <Link
                                key={review.id}
                                href={`/history/${review.type === 'PR' ? 'github_pr' : 'paste_code'}/${review.id}`}
                                className="block rounded-lg border border-gray-800 bg-gray-900/40 p-4
                                           hover:border-gray-700 hover:bg-gray-900/60 transition-colors"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-center gap-2 shrink-0">
                                        <ScoreBadge score={review.score} />
                                        <Badge variant={review.type === 'PR' ? 'purple' : 'blue'}>
                                            {review.type === 'PR'
                                                ? <GitPullRequest className="w-3 h-3" />
                                                : <Code2 className="w-3 h-3" />}
                                            {review.type}
                                        </Badge>
                                    </div>

                                    <p className="flex-1 text-sm text-gray-300 leading-snug line-clamp-2">
                                        {review.summary}
                                    </p>

                                    <div className="shrink-0 text-right space-y-1">
                                        <p className="text-xs text-gray-500">
                                            {new Date(review.createdAt).toLocaleDateString('en-US', {
                                                month: 'short', day: 'numeric', year: 'numeric',
                                            })}
                                        </p>
                                        {review._count.issues > 0 && (
                                            <p className="text-xs text-gray-600">
                                                {review._count.issues} issue{review._count.issues !== 1 ? 's' : ''}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </main>
        </div>
    )
}
