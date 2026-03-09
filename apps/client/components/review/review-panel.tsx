import { CheckCircle2 } from 'lucide-react'
import { ScoreRing } from './score-ring'
import { IssueCard } from './issue-card'
import type { ReviewData } from '@/types/review.types'

// Renders the full structured review: score, summary, issue cards, and positives.
export function ReviewPanel({ review }: { review: ReviewData }) {
    const criticalCount = review.issues.filter(i => i.severity === 'critical').length
    const warningCount = review.issues.filter(i => i.severity === 'warning').length

    return (
        <div className="space-y-4">
            {/* Header: score ring + summary */}
            <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-5 flex items-start gap-5">
                <ScoreRing score={review.score} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                        <h2 className="text-sm font-semibold text-white">Overall Assessment</h2>
                        {criticalCount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-red-900/60 text-red-300 border border-red-700/60">
                                {criticalCount} critical
                            </span>
                        )}
                        {warningCount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-yellow-900/60 text-yellow-300 border border-yellow-700/60">
                                {warningCount} warning{warningCount > 1 ? 's' : ''}
                            </span>
                        )}
                        {review.issues.length === 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-green-900/60 text-green-300 border border-green-700/60">
                                No issues found
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed">{review.summary}</p>
                </div>
            </div>

            {/* Issues list */}
            {review.issues.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">
                        Issues ({review.issues.length})
                    </h3>
                    {review.issues.map((issue, i) => (
                        <IssueCard key={i} issue={issue} />
                    ))}
                </div>
            )}

            {/* Positives */}
            {review.positives.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">
                        {"What's good"}
                    </h3>
                    <div className="rounded-xl border border-green-900/40 bg-green-950/20 p-4 space-y-2">
                        {review.positives.map((p, i) => (
                            <div key={i} className="flex items-start gap-2 text-sm text-green-300">
                                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
                                <span>{p}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
