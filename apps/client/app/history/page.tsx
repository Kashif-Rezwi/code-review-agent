'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Code2, BookOpen, GitPullRequest, History, XCircle, Shield, Zap, Wrench, Lightbulb } from 'lucide-react'

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

const TYPE_ICONS: Record<string, React.ReactNode> = {
    bug: <XCircle className="w-3.5 h-3.5 text-red-400" />,
    security: <Shield className="w-3.5 h-3.5 text-orange-400" />,
    performance: <Zap className="w-3.5 h-3.5 text-yellow-400" />,
    style: <Wrench className="w-3.5 h-3.5 text-blue-400" />,
    suggestion: <Lightbulb className="w-3.5 h-3.5 text-purple-400" />,
}

function ScoreBadge({ score }: { score: number }) {
    const color =
        score >= 8 ? 'text-green-400 bg-green-900/40 border-green-700/60' :
        score >= 5 ? 'text-yellow-400 bg-yellow-900/40 border-yellow-700/60' :
                    'text-red-400 bg-red-900/40 border-red-700/60'
    return (
        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold border ${color}`}>
            {score}/10
        </span>
    )
}

export default function HistoryPage() {
    const [reviews, setReviews] = useState<ReviewSummary[]>([])
    const [stats, setStats] = useState<Stats | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const apiUrl = process.env.NEXT_PUBLIC_API_URL

    useEffect(() => {
        const load = async () => {
            try {
                const [reviewsRes, statsRes] = await Promise.all([
                    fetch(`${apiUrl}/history`),
                    fetch(`${apiUrl}/history/stats`),
                ])
                if (!reviewsRes.ok || !statsRes.ok) throw new Error('Failed to load history.')
                const [reviewsData, statsData] = await Promise.all([
                    reviewsRes.json(),
                    statsRes.json(),
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
    }, [apiUrl])

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Code2 className="w-5 h-5 text-blue-400" />
                    <span className="font-semibold text-white">Code Review Agent</span>
                </div>
                <div className="flex items-center gap-4">
                    <Link
                        href="/review"
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                    >
                        <Code2 className="w-3.5 h-3.5" />
                        Review
                    </Link>
                    <Link
                        href="/standards"
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                    >
                        <BookOpen className="w-3.5 h-3.5" />
                        Standards
                    </Link>
                    <span className="text-xs text-gray-500">Week 5 — Memory</span>
                </div>
            </header>

            <main className="max-w-4xl mx-auto p-6 space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <History className="w-6 h-6 text-blue-400" />
                        Review History
                    </h1>
                    <p className="text-gray-400 text-sm mt-1">
                        All past code reviews. Click any review to view details and continue the conversation.
                    </p>
                </div>

                {error && (
                    <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 rounded-lg p-4 text-sm text-red-300">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        {error}
                    </div>
                )}

                {/* Stats bar */}
                {stats && stats.totalReviews > 0 && (
                    <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                Issue Trends
                            </span>
                            <span className="text-xs text-gray-500">
                                {stats.totalReviews} review{stats.totalReviews !== 1 ? 's' : ''} total
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {stats.issuesByType.map(({ type, count }) => (
                                <div
                                    key={type}
                                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-800 border border-gray-700 text-xs text-gray-300"
                                >
                                    {TYPE_ICONS[type]}
                                    <span className="capitalize">{type}</span>
                                    <span className="text-gray-500">×{count}</span>
                                </div>
                            ))}
                            {stats.issuesByType.length === 0 && (
                                <span className="text-xs text-gray-600">No issues recorded yet.</span>
                            )}
                        </div>
                    </div>
                )}

                {/* Review list */}
                {isLoading ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map((n) => (
                            <div key={n} className="h-20 rounded-xl bg-gray-800/40 animate-pulse" />
                        ))}
                    </div>
                ) : reviews.length === 0 ? (
                    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-10 text-center">
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
                                href={`/history/${review.id}`}
                                className="block rounded-xl border border-gray-700 bg-gray-900/60 p-4
                                           hover:border-gray-600 hover:bg-gray-900/80 transition-colors group"
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        <ScoreBadge score={review.score} />
                                        <span
                                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                                                review.type === 'PR'
                                                    ? 'text-purple-300 bg-purple-900/40 border-purple-700/60'
                                                    : 'text-blue-300 bg-blue-900/40 border-blue-700/60'
                                            }`}
                                        >
                                            {review.type === 'PR' ? (
                                                <GitPullRequest className="w-3 h-3" />
                                            ) : (
                                                <Code2 className="w-3 h-3" />
                                            )}
                                            {review.type}
                                        </span>
                                    </div>

                                    <p className="flex-1 text-sm text-gray-300 leading-snug line-clamp-2">
                                        {review.summary}
                                    </p>

                                    <div className="flex-shrink-0 text-right space-y-1">
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
