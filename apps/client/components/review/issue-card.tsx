import { Info, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TYPE_CONFIG, SEVERITY_CONFIG } from '@/types/review-config'
import type { ReviewIssue } from '@/types/review.types'

// Displays a single review issue with type icon, severity badge, location, description, and fix recommendation.
export function IssueCard({ issue }: { issue: ReviewIssue }) {
    const typeConf = TYPE_CONFIG[issue.type] ?? TYPE_CONFIG.suggestion
    const sevConf = SEVERITY_CONFIG[issue.severity] ?? SEVERITY_CONFIG.info
    const Icon = typeConf.icon

    return (
        <div className={cn('rounded-lg border p-4 space-y-3', typeConf.bg)}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <Icon className={cn('w-4 h-4 shrink-0', typeConf.color)} />
                    <span className="text-sm font-medium text-white">{issue.title}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={cn('px-2 py-0.5 rounded text-xs border font-medium', sevConf.badge)}>
                        {sevConf.label}
                    </span>
                    <span className="px-2 py-0.5 rounded text-xs border bg-gray-900/60 text-gray-500 border-gray-800">
                        {typeConf.label}
                    </span>
                </div>
            </div>

            {issue.location && (
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                    <ChevronRight className="w-3 h-3" />
                    <span className="font-mono">{issue.location}</span>
                </div>
            )}

            <p className="text-sm text-gray-300 leading-relaxed">{issue.description}</p>

            {issue.recommendation && (
                <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/15 rounded-lg p-3 shadow-[0_0_10px_rgba(59,130,246,0.04)]">
                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-400/80" />
                    <p className="text-xs text-gray-400 leading-relaxed">
                        <span className="text-blue-400/90 font-medium">Fix: </span>
                        {issue.recommendation}
                    </p>
                </div>
            )}
        </div>
    )
}
