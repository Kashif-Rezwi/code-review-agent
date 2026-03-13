'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { ReviewInputDisplay } from '@/components/review/review-input-display'
import { ChatPanel } from '@/components/review/chat-panel'
import { apiFetch } from '@/lib/api'
import type { ReviewData, ChatMessage } from '@/types/review.types'

// Extends ReviewData with fields only present in a persisted review
interface FullReview extends ReviewData {
    id: string
    type: 'CODE' | 'PR'
    input: string
    conversations: ChatMessage[]
}

export default function ReviewDetailPage() {
    const { id } = useParams<{ id: string }>()
    const [review, setReview] = useState<FullReview | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        apiFetch<FullReview>(`/history/${id}`)
            .then(setReview)
            .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load review.'))
            .finally(() => setIsLoading(false))
    }, [id])

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            <AppHeader />

            <main className="max-w-4xl mx-auto p-6 space-y-6">
                <Link
                    href="/history"
                    className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to History
                </Link>

                {error && <ErrorBanner message={error} />}

                {isLoading && <ReviewSkeleton />}

                {review && (
                    <>
                        {/* Original input — PR link or read-only code */}
                        <ReviewInputDisplay type={review.type} input={review.input} />

                        {/* Review results */}
                        <ReviewPanel review={review} />

                        {/* Follow-up chat with full persisted history */}
                        <ChatPanel reviewId={review.id} initialMessages={review.conversations} />
                    </>
                )}
            </main>
        </div>
    )
}
