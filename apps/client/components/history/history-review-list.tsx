'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { Code2, GitPullRequest, History, Loader2, Trash2 } from 'lucide-react'
import { ScoreBadge } from '@/components/review/score-badge'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useVirtualScroll } from '@/lib/use-virtual-scroll'

export interface ReviewSummary {
    id: string
    type: 'CODE' | 'PR'
    summary: string
    score: number
    createdAt: string
    _count: { issues: number }
}

interface HistoryReviewListProps {
    reviews: ReviewSummary[]
    isLoading: boolean
    onDelete?: (id: string) => Promise<void>
}

// Rendered item height (mirrors py-3 rows: 24px padding + ~24px content = ~48px).
const ITEM_HEIGHT = 48
// Inter-row gap — matches the original space-y-1.5 (6px).
const ROW_GAP = 6
// Total vertical space each row slot occupies (item + gap below it).
const ROW_HEIGHT = ITEM_HEIGHT + ROW_GAP

export function HistoryReviewList({ reviews, isLoading, onDelete }: HistoryReviewListProps) {
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
    const [deletingId, setDeletingId] = useState<string | null>(null)

    const { containerRef, onScroll, totalHeight, startIndex, endIndex } = useVirtualScroll(
        reviews.length,
        ROW_HEIGHT,
    )

    const handleConfirm = useCallback(async () => {
        if (!pendingDeleteId || !onDelete) return
        setDeletingId(pendingDeleteId)
        try {
            await onDelete(pendingDeleteId)
        } finally {
            setDeletingId(null)
            setPendingDeleteId(null)
        }
    }, [pendingDeleteId, onDelete])

    if (isLoading) {
        return (
            <div className="space-y-1.5">
                {[1, 2, 3, 4, 5].map((n) => (
                    <div key={n} className="rounded-lg border border-gray-800/60 bg-gray-900/30 px-4 py-3 animate-pulse">
                        <div className="flex items-center gap-3">
                            <div className="h-5 w-10 rounded-full bg-gray-700/80 shrink-0" />
                            <div className="h-4 w-14 rounded-full bg-gray-800 shrink-0" />
                            <div className="flex-1 h-3 bg-gray-700/60 rounded" />
                            <div className="h-3 w-20 bg-gray-800 rounded shrink-0" />
                        </div>
                    </div>
                ))}
            </div>
        )
    }

    if (reviews.length === 0) {
        return (
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
        )
    }

    return (
        <>
            {/*
              Scrollable viewport. max-h fills the screen space below the stats panel;
              min-h prevents it collapsing when there are only a few items.
            */}
            <div
                ref={containerRef}
                onScroll={onScroll}
                className="overflow-y-auto max-h-[calc(100vh-22rem)] min-h-[12rem]"
            >
                {/*
                  Full-height spacer: sets the scrollbar thumb size to accurately
                  reflect the total number of items, even unrendered ones.
                */}
                <div style={{ height: totalHeight, position: 'relative' }}>
                    {reviews.slice(startIndex, endIndex + 1).map((review, i) => {
                        const index = startIndex + i
                        const isDeleting = deletingId === review.id
                        const href = `/history/${review.type === 'PR' ? 'github_pr' : 'paste_code'}/${review.id}`

                        return (
                            /*
                              Slot wrapper: exactly ITEM_HEIGHT tall so the 6 px gap
                              below it (ROW_HEIGHT - ITEM_HEIGHT) is transparent space
                              between adjacent row borders — no overflow risk.
                            */
                            <div
                                key={review.id}
                                style={{
                                    position: 'absolute',
                                    top: index * ROW_HEIGHT,
                                    left: 0,
                                    right: 0,
                                    height: ITEM_HEIGHT,
                                }}
                            >
                                <div className="group flex items-center gap-3 h-full rounded-lg border border-gray-800/60 bg-gray-900/30 px-4 hover:border-gray-700/80 hover:bg-gray-900/50 transition-all duration-150">

                                    {/* Score + type badges */}
                                    <div className="flex items-center gap-2 shrink-0">
                                        <ScoreBadge score={review.score} />
                                        <Badge variant={review.type === 'PR' ? 'purple' : 'blue'}>
                                            {review.type === 'PR'
                                                ? <GitPullRequest className="w-3 h-3" />
                                                : <Code2 className="w-3 h-3" />}
                                            {review.type}
                                        </Badge>
                                    </div>

                                    {/* Summary — clickable */}
                                    <Link href={href} className="flex-1 min-w-0">
                                        <p className="text-sm text-gray-400 truncate leading-snug group-hover:text-gray-200 transition-colors duration-150">
                                            {review.summary}
                                        </p>
                                    </Link>

                                    {/* Date + issue count */}
                                    <div className="shrink-0 text-right hidden sm:block">
                                        <p className="text-xs text-gray-600">
                                            {new Date(review.createdAt).toLocaleDateString('en-US', {
                                                month: 'short', day: 'numeric', year: 'numeric',
                                            })}
                                        </p>
                                        {review._count.issues > 0 && (
                                            <p className="text-xs text-gray-700 mt-0.5">
                                                {review._count.issues} issue{review._count.issues !== 1 ? 's' : ''}
                                            </p>
                                        )}
                                    </div>

                                    {/* Delete button — always visible, subtle by default */}
                                    {onDelete && (
                                        <button
                                            type="button"
                                            onClick={() => setPendingDeleteId(review.id)}
                                            disabled={isDeleting}
                                            title="Delete review"
                                            className="shrink-0 flex items-center justify-center h-7 w-7 rounded-md
                                                       text-gray-700 hover:text-red-400 hover:bg-red-500/10
                                                       border border-transparent hover:border-red-500/20
                                                       transition-all duration-150 active:scale-90
                                                       disabled:cursor-not-allowed cursor-pointer"
                                        >
                                            {isDeleting
                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-red-400" />
                                                : <Trash2 className="h-3.5 w-3.5" />
                                            }
                                        </button>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {pendingDeleteId && (
                <ConfirmDialog
                    title="Delete Review"
                    description="This will permanently delete this review and all its associated data. This action cannot be undone."
                    confirmLabel="Delete"
                    isLoading={!!deletingId}
                    onConfirm={handleConfirm}
                    onCancel={() => setPendingDeleteId(null)}
                />
            )}
        </>
    )
}
