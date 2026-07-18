import { AlertTriangle, BookOpen, CheckCircle2, FileWarning } from 'lucide-react'
import { ScoreRing } from './score-ring'
import { IssueCard } from './issue-card'
import type { ReviewData } from '@/types/review.types'

// Renders the full structured review: score, summary, issue cards, positives, and
// an optional badge showing which coding-standards documents were applied (Week 4 RAG).
export function ReviewPanel({ review }: { review: ReviewData }) {
    const criticalCount = review.issues.filter(i => i.severity === 'critical').length
    const warningCount = review.issues.filter(i => i.severity === 'warning').length
    const coverage = review.coverage
    const isPartial = (coverage?.failedClusters.length ?? 0) > 0 || (coverage?.unreviewedFiles.length ?? 0) > 0
    const hasContextWarnings = (coverage?.truncatedFiles.length ?? 0) > 0 || (coverage?.metadataOnlyFiles.length ?? 0) > 0

    return (
        <div className="space-y-4">
            {coverage && (isPartial || hasContextWarnings) && (
                <div className={`rounded-lg border px-4 py-3 ${isPartial
                    ? 'border-amber-500/40 bg-amber-950/20'
                    : 'border-blue-500/25 bg-blue-950/10'
                }`}>
                    <div className="flex items-start gap-2.5">
                        {isPartial
                            ? <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-400" />
                            : <FileWarning className="h-4 w-4 mt-0.5 shrink-0 text-blue-400" />
                        }
                        <div className="min-w-0 space-y-1.5">
                            <p className={`text-sm font-medium ${isPartial ? 'text-amber-200' : 'text-blue-200'}`}>
                                {isPartial
                                    ? `Partial review — ${coverage.reviewedFiles}/${coverage.totalFiles} files reviewed`
                                    : `Review completed with limited context for ${coverage.truncatedFiles.length + coverage.metadataOnlyFiles.length} file${coverage.truncatedFiles.length + coverage.metadataOnlyFiles.length === 1 ? '' : 's'}`
                                }
                            </p>
                            <p className="text-xs text-gray-400">
                                Acquired via {coverage.acquisitionSource === 'public_diff' ? 'the public diff fallback' : 'the GitHub files API'}.
                            </p>
                            {coverage.unreviewedFiles.length > 0 && (
                                <CoverageFileList label="Not reviewed" files={coverage.unreviewedFiles} tone="amber" />
                            )}
                            {coverage.truncatedFiles.length > 0 && (
                                <CoverageFileList label="Truncated context" files={coverage.truncatedFiles} tone="blue" />
                            )}
                            {coverage.metadataOnlyFiles.length > 0 && (
                                <CoverageFileList label="Metadata only" files={coverage.metadataOnlyFiles} tone="gray" />
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Header: score ring + summary */}
            <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 flex items-start gap-4">
                <ScoreRing score={review.score} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                        <h2 className="text-sm font-semibold text-white">Overall Assessment</h2>
                        {criticalCount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-red-950/40 text-red-400 border border-red-800/50">
                                {criticalCount} critical
                            </span>
                        )}
                        {warningCount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-yellow-950/40 text-yellow-400/80 border border-yellow-800/50">
                                {warningCount} warning{warningCount > 1 ? 's' : ''}
                            </span>
                        )}
                        {review.issues.length === 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-green-950/40 text-green-400 border border-green-800/50">
                                No issues found
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-gray-400 leading-relaxed">{review.summary}</p>
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
                    <div className="rounded-lg border border-green-900/30 bg-green-950/10 p-4 space-y-2">
                        {review.positives.map((p, i) => (
                            <div key={i} className="flex items-start gap-2 text-sm text-green-400/80">
                                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-500/70" />
                                <span>{p}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Applied coding standards (only shown when RAG retrieved relevant chunks) */}
            {(review.appliedStandards?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 flex items-center gap-2 shadow-[0_0_15px_rgba(59,130,246,0.06)]">
                    <BookOpen className="w-4 h-4 text-blue-400 shrink-0" />
                    <span className="text-xs text-blue-300/70">
                        Reviewed against your team&apos;s standards:{' '}
                        <span className="font-medium text-blue-200/80">
                            {review.appliedStandards!.join(', ')}
                        </span>
                    </span>
                </div>
            )}
        </div>
    )
}

function CoverageFileList({
    label,
    files,
    tone,
}: {
    label: string
    files: string[]
    tone: 'amber' | 'blue' | 'gray'
}) {
    const color = tone === 'amber' ? 'text-amber-300/80' : tone === 'blue' ? 'text-blue-300/80' : 'text-gray-400'
    return (
        <p className="text-xs text-gray-500 break-words">
            <span className={color}>{label}:</span>{' '}
            {files.join(', ')}
        </p>
    )
}
