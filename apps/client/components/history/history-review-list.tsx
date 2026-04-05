'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { Code2, GitPullRequest, History, Loader2, Trash2 } from 'lucide-react'
import { ScoreBadge } from '@/components/review/score-badge'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

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

export function HistoryReviewList({ reviews, isLoading, onDelete }: HistoryReviewListProps) {
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
    const [deletingId, setDeletingId] = useState<string | null>(null)

    const handleDeleteClick = useCallback((e: React.MouseEvent, id: string) => {
        e.preventDefault()
        e.stopPropagation()
        setPendingDeleteId(id)
    }, [])

    const handleConfirm = useCallback(async () => {
        if (!pendingDeleteId || !onDelete) return
        setDeletingId(pendingDeleteId)
        setPendingDeleteId(null)
        try {
            await onDelete(pendingDeleteId)
        } finally {
            setDeletingId(null)
        }
    }, [pendingDeleteId, onDelete])

    const handleCancel = useCallback(() => {
        setPendingDeleteId(null)
    }, [])

    if (isLoading) {
        return (
            <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((n) => (
                    <div key={n} className="rounded-lg border border-gray-800 bg-gray-900/40 p-4 animate-pulse">
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex items-center gap-2 shrink-0">
                                <div className="h-5 w-11 rounded-full bg-gray-700" />
                                <div className="h-5 w-14 rounded-full bg-gray-800" />
                            </div>
                            <div className="flex-1 space-y-2 min-w-0 pt-0.5">
                                <div className="h-3 bg-gray-700 rounded w-full" />
                                <div className="h-3 bg-gray-800 rounded w-4/5" />
                            </div>
                            <div className="shrink-0 space-y-1.5 text-right">
                                <div className="h-3 bg-gray-800 rounded w-20" />
                                <div className="h-3 bg-gray-800 rounded w-14 ml-auto" />
                            </div>
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

    const pendingReview = reviews.find(r => r.id === pendingDeleteId)

    return (
        <>
            <div className="space-y-2">
                {reviews.map((review) => {
                    const isDeleting = deletingId === review.id
                    return (
                        <div key={review.id} className="group relative">
                            <Link
                                href={`/history/${review.type === 'PR' ? 'github_pr' : 'paste_code'}/${review.id}`}
                                className="block rounded-lg border border-gray-800 bg-gray-900/40 p-4 pr-12
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

                            {/* Delete button — visible on hover or while deleting */}
                            {onDelete && (
                                <button
                                    type="button"
                                    onClick={(e) => handleDeleteClick(e, review.id)}
                                    disabled={isDeleting}
                                    title="Delete review"
                                    className="absolute right-3 top-1/2 -translate-y-1/2
                                               flex items-center justify-center h-7 w-7 rounded-md
                                               text-gray-600 hover:text-red-400 hover:bg-red-500/10
                                               border border-transparent hover:border-red-500/20
                                               opacity-0 group-hover:opacity-100
                                               transition-all duration-150 active:scale-90
                                               disabled:cursor-not-allowed cursor-pointer"
                                >
                                    {isDeleting ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-red-400" />
                                    ) : (
                                        <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                </button>
                            )}
                        </div>
                    )
                })}
            </div>

            {/* Confirm Dialog */}
            {pendingDeleteId && pendingReview && (
                <ConfirmDialog
                    title="Delete Review"
                    description={`This will permanently delete this review and all its associated data. This action cannot be undone.`}
                    confirmLabel="Delete"
                    onConfirm={handleConfirm}
                    onCancel={handleCancel}
                />
            )}
        </>
    )
}
