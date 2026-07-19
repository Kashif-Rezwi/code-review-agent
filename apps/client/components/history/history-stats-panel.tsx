'use client'

import { TYPE_CONFIG } from '@/types/review-config'

export interface Stats {
    totalReviews: number
    partialReviews: number
    issuesByType: Array<{ type: string; count: number }>
    issuesBySeverity: Array<{ severity: string; count: number }>
}

interface HistoryStatsPanelProps {
    stats: Stats | null
    isLoading: boolean
}

export function HistoryStatsPanel({ stats, isLoading }: HistoryStatsPanelProps) {
    if (isLoading) {
        return (
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
        )
    }

    if (!stats || stats.totalReviews === 0) return null

    return (
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 space-y-3">
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Issue Trends
                </span>
                <span className="text-xs text-gray-500">
                    {stats.totalReviews} review{stats.totalReviews !== 1 ? 's' : ''} total
                </span>
            </div>
            {stats.partialReviews > 0 && (
                <div className="inline-flex items-center gap-1.5 self-start rounded-full border border-amber-500/25 bg-amber-950/20 px-2.5 py-1 text-xs text-amber-300/80">
                    {stats.partialReviews} partial review{stats.partialReviews !== 1 ? 's' : ''}
                </div>
            )}
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
    )
}
