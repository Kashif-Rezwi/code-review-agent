'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Activity } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { ReviewInputDisplay } from '@/components/review/review-input-display'
import { ReviewProgress } from '@/components/review/review-progress'
import { ChatThread } from '@/components/review/chat-thread'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { useTraceReplay } from '@/lib/use-trace-replay'
import { apiFetch } from '@/lib/api'
import type { ReviewData, ChatMessage, ReviewStreamEvent } from '@/types/review.types'

interface FullReview extends ReviewData {
    id: string
    type: 'CODE' | 'PR'
    input: string
    conversations: ChatMessage[]
    traceLog: ReviewStreamEvent[] | null
}

export default function ReviewDetailPage() {
    const { id } = useParams<{ id: string }>()
    const [review, setReview] = useState<FullReview | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const { messages, input, setInput, isSending, streamingContent, submit } = useChatMessages(id, review?.conversations)

    const reviewPanelRef = useRef<HTMLDivElement>(null)
    const chatSectionRef = useRef<HTMLDivElement>(null)

    // use-stick-to-bottom: classifies wheel/pointer input to distinguish user scroll
    // from programmatic scroll — eliminates the race condition that causes jitter.
    const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({ initial: false })

    useEffect(() => {
        apiFetch<FullReview>(`/history/${id}`)
            .then(setReview)
            .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load review.'))
            .finally(() => setIsLoading(false))
    }, [id])

    const handleSubmit = useCallback(async () => {
        scrollToBottom()
        await submit()
    }, [submit, scrollToBottom])

    // Returns empty structures for pre-migration reviews (traceLog === null)
    const { traceEntries, clusterMap, taskItems, totalDurationMs, mode } =
        useTraceReplay(review?.traceLog ?? null)

    const hasTrace = traceEntries.length > 0 || clusterMap.size > 0 || taskItems.length > 0

    return (
        <div className="h-screen flex flex-col bg-app-bg text-gray-100">
            <AppHeader />

            <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hide">
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

                            {/* ── Agent Trace Replay ─────────────────────────────────────── */}
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
                                        />
                                    </div>
                                </div>
                            )}

                            <div ref={reviewPanelRef} className="scroll-mt-12">
                                <ReviewPanel review={review} />
                            </div>

                            <div ref={chatSectionRef}>
                                <ChatThread
                                    messages={messages}
                                    streamingContent={streamingContent}
                                    isSending={isSending}
                                />
                            </div>
                        </>
                    )}
                </main>
            </div>

            {/* Fixed input overlay — rendered at page root, outside the scroll container */}
            {review && (
                <ChatInput
                    value={input}
                    onChange={setInput}
                    onSubmit={handleSubmit}
                    disabled={isSending}
                    chatSectionRef={chatSectionRef}
                    isAtBottom={isAtBottom}
                    onScrollToReview={() => reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth' })}
                    onScrollToLatest={() => scrollToBottom()}
                />
            )}
        </div>
    )
}
