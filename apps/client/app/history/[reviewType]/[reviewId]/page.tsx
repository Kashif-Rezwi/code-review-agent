'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Activity } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { ReviewInputDisplay } from '@/components/review/review-input-display'
import { ReviewProgress } from '@/components/review/review-progress'
import { ReviewErrorBoundary } from '@/components/ui/error-boundary'
import { ChatThread } from '@/components/review/chat-thread'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { useTraceReplay } from '@/lib/use-trace-replay'
import { useReviewScroll } from '@/lib/hooks/use-review-scroll'
import { apiFetch } from '@/lib/api'
import { useSession } from 'next-auth/react'
import type { ReviewData, ChatMessage, ReviewStreamEvent } from '@/types/review.types'

interface FullReview extends ReviewData {
    id: string
    type: 'CODE' | 'PR'
    input: string
    conversations: ChatMessage[]
    traceLog: ReviewStreamEvent[] | null
    status: 'COMPLETE' | 'PARTIAL'
}

export default function ReviewDetailPage() {
    const params = useParams<{ reviewType: string, reviewId: string }>()
    const reviewId = params?.reviewId || ''
    const [review, setReview] = useState<FullReview | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const { data: session, status } = useSession()
    const githubToken = session?.githubToken

    const { messages, input, setInput, isSending, streamingContent, submit } = useChatMessages(reviewId, review?.conversations, githubToken)

    const reviewPanelRef = useRef<HTMLDivElement>(null)
    const chatSectionRef = useRef<HTMLDivElement>(null)

    const { bottomRef, contentRef, scrollToBottom, isAtBottom, isAtBottomRef } = useReviewScroll({ isStreaming: false })

    useEffect(() => {
        if (!githubToken || !reviewId) return
        apiFetch<FullReview>(`/history/${reviewId}`, undefined, githubToken)
            .then(res => {
                setReview(res)
                // Smooth glide on initial data load
                setTimeout(() => {
                    reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth' })
                }, 300)
            })
            .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load review.'))
            .finally(() => setIsLoading(false))
    }, [reviewId, githubToken])

    const handleSubmit = useCallback(async () => {
        isAtBottomRef.current = true
        scrollToBottom('smooth')
        await submit()
    }, [submit, scrollToBottom, isAtBottomRef])

    // Hooks must run before the early returns below (React Error 310)
    const {
        traceEntries, clusterMap, taskItems, totalDurationMs, mode,
        acquisition, outcome, synthesisStarted,
    } = useTraceReplay(review?.traceLog ?? null, review?.type)

    const hasTrace = traceEntries.length > 0 || clusterMap.size > 0 || taskItems.length > 0

    if (status === 'loading') {
        return (
            <div className="min-h-screen flex flex-col bg-app-bg text-gray-100">
                <AppHeader />
                <main className="max-w-4xl mx-auto w-full px-6 pt-8 space-y-6">
                    <div className="h-4 w-24 bg-gray-800 rounded animate-pulse" />
                    <div className="h-full w-full bg-gray-900/40 border border-gray-800 rounded-lg animate-pulse" style={{ minHeight: 300 }} />
                </main>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-app-bg text-gray-100">
            <AppHeader />

            <main ref={contentRef} className="max-w-4xl mx-auto w-full px-6 space-y-6 pt-8 pb-24">
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
                        <ReviewInputDisplay type={review.type} input={review.input} />

                        {hasTrace && (
                            <div className="rounded-lg border border-gray-800 bg-gray-900/20 overflow-hidden">
                                <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800/60">
                                    <Activity className="w-3.5 h-3.5 text-gray-600" />
                                    <span className="text-xs font-semibold uppercase tracking-widest text-gray-600">
                                        Agent Trace
                                    </span>
                                    {totalDurationMs != null && (
                                        <span className="ml-auto text-xs text-gray-700">
                                            {(totalDurationMs / 1000).toFixed(1)}s
                                        </span>
                                    )}
                                </div>
                                <div className="p-4">
                                    <ReviewProgress
                                        entries={traceEntries}
                                        taskItems={taskItems}
                                        phase="complete"
                                        clusterMap={clusterMap}
                                        totalDurationMs={totalDurationMs}
                                        mode={mode}
                                        acquisition={acquisition}
                                        outcome={outcome ?? (review.status === 'PARTIAL' ? 'partial' : 'complete')}
                                        synthesisStarted={synthesisStarted}
                                    />
                                </div>
                            </div>
                        )}

                        <ReviewErrorBoundary onReset={() => {}}>
                            <div ref={reviewPanelRef} className="scroll-mt-20">
                                <ReviewPanel review={review} />
                            </div>

                            <div ref={chatSectionRef}>
                                <ChatThread
                                    messages={messages}
                                    streamingContent={streamingContent}
                                    isSending={isSending}
                                />
                            </div>
                        </ReviewErrorBoundary>
                    </>
                )}
                <div ref={bottomRef} />
            </main>

            {review && (
                <ChatInput
                    value={input}
                    onChange={setInput}
                    onSubmit={handleSubmit}
                    disabled={isSending}
                    chatSectionRef={chatSectionRef}
                    isAtBottom={isAtBottom}
                    onScrollToReview={() => reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth' })}
                    onScrollToLatest={() => scrollToBottom('smooth')}
                />
            )}
        </div>
    )
}
