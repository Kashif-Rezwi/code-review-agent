'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Activity } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { ReviewInputDisplay } from '@/components/review/review-input-display'
import { ReviewProgress } from '@/components/review/review-progress'
import { UserBubble, AssistantMessage, LoadingIndicator } from '@/components/review/chat-message'
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
    const [review,    setReview]    = useState<FullReview | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error,     setError]     = useState<string | null>(null)

    const { messages, setMessages, input, setInput, isSending, submit } = useChatMessages(id)

    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const bottomRef          = useRef<HTMLDivElement>(null)

    useEffect(() => {
        apiFetch<FullReview>(`/history/${id}`)
            .then((data) => { setReview(data); setMessages(data.conversations) })
            .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load review.'))
            .finally(() => setIsLoading(false))
    }, [id])  // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages, isSending])

    // Replay the stored trace synchronously — no streaming needed.
    // Returns empty structures for pre-migration reviews (traceLog === null).
    const { traceEntries, clusterMap, taskItems, totalDurationMs, mode } =
        useTraceReplay(review?.traceLog ?? null)

    const hasTrace = traceEntries.length > 0 || clusterMap.size > 0 || taskItems.length > 0

    return (
        <div className="h-screen flex flex-col bg-[#0d1117] text-gray-100">
            <AppHeader />

            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scroll-hide flex flex-col">
                {/* Top gradient fade */}
                <div className="sticky top-0 z-10 pointer-events-none">
                    <div className="h-8 bg-gradient-to-b from-[#0d1117] to-transparent" />
                </div>

                {/* pb-24 ensures content is never obscured by the fixed input overlay */}
                <main className="flex-1 max-w-4xl mx-auto w-full px-6 space-y-6 pt-2 pb-24">
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

                            <ReviewPanel review={review} />

                            {/* Messages — keyed by index (safe: list is append-only) */}
                            {messages.map((msg, i) =>
                                msg.role === 'user'
                                    ? <UserBubble key={i} content={msg.content} />
                                    : <AssistantMessage key={i} content={msg.content} />
                            )}

                            {isSending && <LoadingIndicator />}
                            <div ref={bottomRef} />
                        </>
                    )}
                </main>
            </div>

            {/* Fixed input overlay — rendered at page root, outside the scroll container */}
            {review && (
                <ChatInput
                    value={input}
                    onChange={setInput}
                    onSubmit={submit}
                    disabled={isSending}
                    scrollContainerRef={scrollContainerRef}
                />
            )}
        </div>
    )
}
