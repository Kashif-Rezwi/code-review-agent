'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, Code2, BookOpen, History } from 'lucide-react'
import { ReviewPanel } from '@/components/review/review-panel'
import { ChatPanel } from '@/components/review/chat-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import type { ReviewData } from '@/types/review.types'

interface Conversation {
    role: 'user' | 'assistant'
    content: string
}

interface FullReview extends ReviewData {
    id: string
    type: 'CODE' | 'PR'
    conversations: Conversation[]
}

export default function ReviewDetailPage() {
    const { id } = useParams<{ id: string }>()
    const [review, setReview] = useState<FullReview | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const apiUrl = process.env.NEXT_PUBLIC_API_URL

    useEffect(() => {
        const load = async () => {
            try {
                const res = await fetch(`${apiUrl}/history/${id}`)
                if (!res.ok) throw new Error('Review not found.')
                setReview(await res.json())
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load review.')
            } finally {
                setIsLoading(false)
            }
        }
        load()
    }, [id, apiUrl])

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
                    <Link
                        href="/history"
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
                    >
                        <History className="w-3.5 h-3.5" />
                        History
                    </Link>
                </div>
            </header>

            <main className="max-w-4xl mx-auto p-6 space-y-6">
                <Link
                    href="/history"
                    className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to History
                </Link>

                {error && (
                    <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 rounded-lg p-4 text-sm text-red-300">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        {error}
                    </div>
                )}

                {isLoading && <ReviewSkeleton />}

                {review && (
                    <>
                        <ReviewPanel review={review} />
                        <ChatPanel
                            reviewId={review.id}
                            initialMessages={review.conversations}
                        />
                    </>
                )}
            </main>
        </div>
    )
}
