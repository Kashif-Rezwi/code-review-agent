'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { useRouter } from 'next/navigation'
import { AlertTriangle, BrainCircuit, Code2, GitPullRequest, Loader2, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppHeader } from '@/components/layout/app-header'
import { PageHeader } from '@/components/layout/page-header'
import { CodeEditor } from '@/components/review/code-editor'
import { detectLanguage, estimateTokens, CODE_TOKEN_LIMIT } from '@/lib/detect-language'
import { isValidPrUrl } from '@/lib/validate'
import { PrUrlInput } from '@/components/ui/pr-url-input'
import { useSession } from 'next-auth/react'
import { API_URL } from '@/lib/api'

import { ErrorBanner } from '@/components/ui/error-banner'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewProgress } from '@/components/review/review-progress'
import { ChatThread } from '@/components/review/chat-thread'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { useReviewStream } from '@/lib/use-review-stream'
import { ReviewErrorBoundary } from '@/components/ui/error-boundary'
import { ReviewInputDisplay } from '@/components/review/review-input-display'
import { ReviewSkeleton } from '@/components/review/review-skeleton'

type Mode = 'code' | 'pr'

const SCROLL_THRESHOLD = 120

export function ReviewContainer({ initialReviewId }: { initialReviewId?: string }) {
    const router = useRouter()
    const { data: session, status } = useSession()
    const githubToken = session?.githubToken

    // Session State
    const [activeReviewId, setActiveReviewId] = useState<string | null>(initialReviewId ?? null)
    
    // Input State
    const [mode, setMode] = useState<Mode>('code')
    const [code, setCode] = useState('')
    const [prUrl, setPrUrl] = useState('')
    
    const [isCreatingSession, setIsCreatingSession] = useState(false)
    const [isFetchingInitial, setIsFetchingInitial] = useState(!!initialReviewId)
    const [initialFetchError, setInitialFetchError] = useState<string | null>(null)

    // Stream & Chat hooks
    const { phase, taskItems, traceEntries, clusterMap, review, error, totalDurationMs, submit, hydrate, reset: resetStream } = useReviewStream(githubToken)
    const { messages, input: chatInput, setInput: setChatInput, isSending, streamingContent, submit: sendChat } = useChatMessages(review?.id ?? null, undefined, githubToken)

    const detectedLanguage = useMemo(() => detectLanguage(code), [code])
    const tokenCount = useMemo(() => estimateTokens(code), [code])
    const isOverLimit = tokenCount > CODE_TOKEN_LIMIT

    // A session is active if we have an ID. During active sessions, input is locked structure.
    const isLocked = !!activeReviewId || isCreatingSession

    const canSubmit = mode === 'code'
        ? code.trim().length > 0 && !isOverLimit
        : isValidPrUrl(prUrl)

    // Refs
    const reviewPanelRef = useRef<HTMLDivElement>(null)
    const chatSectionRef = useRef<HTMLDivElement>(null)

    // use-stick-to-bottom: classifies wheel/pointer input to distinguish user scroll
    // from programmatic scroll — eliminates the race condition that causes jitter.
    const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({ initial: false })

    // Initial Hydration if jumping straight into a review URL
    useEffect(() => {
        if (!initialReviewId || status === 'loading') return

        const fetchReview = async () => {
            setInitialFetchError(null)
            try {
                const res = await fetch(`${API_URL}/review/${initialReviewId}`, {
                    headers: githubToken ? { Authorization: `Bearer ${githubToken}` } : {}
                })
                if (res.status === 404) {
                    router.push('/404')
                    return
                }
                if (!res.ok) {
                    const errText = await res.text().catch(() => '')
                    throw new Error(`Failed to load review: ${res.status} ${errText}`)
                }
                const data = await res.json()
                
                // Repopulate inputs from DB
                setMode(data.type === 'PR' ? 'pr' : 'code')
                if (data.type === 'CODE') setCode(data.input)
                if (data.type === 'PR') setPrUrl(data.input)

                // Starts the active stream pipeline or hydrates instantly if complete
                if (data.status === 'COMPLETE' || data.status === 'FAILED') {
                    hydrate(data, data.traceLog, data.status === 'FAILED' ? (data.summary || 'Review failed.') : null)
                } else {
                    submit(initialReviewId)
                }
            } catch (err) {
                setInitialFetchError(err instanceof Error ? err.message : 'Failed to load review')
            } finally {
                setIsFetchingInitial(false)
            }
        }
        fetchReview()
        
        return () => resetStream()
    }, [initialReviewId, githubToken, status, submit, hydrate, router, resetStream])

    const handleReview = async () => {
        if (!canSubmit || isLocked) return
        setIsCreatingSession(true)

        try {
            const payload = mode === 'code' ? { type: 'CODE', input: code } : { type: 'PR', input: prUrl }
            const res = await fetch(`${API_URL}/review/session`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
                },
                body: JSON.stringify(payload)
            })
            if (!res.ok) {
                 const t = await res.text()
                 throw new Error(`Failed: ${res.status} ${t}`)
            }
            const { reviewId } = await res.json()
            
            // Soft-navigation (ChatGPT style)
            window.history.pushState(null, '', `/review/${reviewId}`)
            setActiveReviewId(reviewId)
            
            // Trigger stream pipeline instantly over SSE
            submit(reviewId)
        } catch (err) {
            console.error(err)
            setInitialFetchError(err instanceof Error ? err.message : 'Session init failed')
        } finally {
            setIsCreatingSession(false)
        }
    }

    const startFresh = () => {
        setActiveReviewId(null)
        setCode('')
        setPrUrl('')
        resetStream()
        window.history.pushState(null, '', '/review')
    }

    // SCROLL HANDLING

    const isStreaming = phase === 'connecting' || phase === 'streaming'

    useEffect(() => {
        if (!review?.id) return
        const id = requestAnimationFrame(() => {
            reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth' })
        })
        return () => cancelAnimationFrame(id)
    }, [review?.id])

    const handleSendChat = useCallback(async () => {
        scrollToBottom()
        await sendChat()
    }, [sendChat, scrollToBottom])

    const displayError = initialFetchError || error

    return (
        <div className="h-screen flex flex-col bg-app-bg text-gray-100">
            <AppHeader />

            <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hide">
                <main ref={contentRef} className="max-w-4xl mx-auto w-full px-6 space-y-6 pt-8 pb-24">
                    <PageHeader
                    title={activeReviewId ? `Session: ${activeReviewId}` : "Review your code"}
                    description={activeReviewId ? 'Pipeline is active and synchronized' : "Paste code directly or provide a GitHub PR URL."}
                />

                {displayError && <ErrorBanner message={displayError} />}

                {isFetchingInitial ? (
                    <ReviewSkeleton />
                ) : (
                    <>
                        {/* The Input Region: Stays on screen permanently as context */}
                        <div>
                    {!activeReviewId ? (
                        <>
                            <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit mb-4">
                                {(['code', 'pr'] as Mode[]).map((m) => (
                                    <button
                                        key={m}
                                        onClick={() => setMode(m)}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${mode === m
                                            ? 'bg-blue-500/15 text-blue-100 border border-blue-500/25 shadow-[0_0_10px_rgba(59,130,246,0.12)]'
                                            : 'text-gray-500 hover:text-gray-300 border border-transparent'
                                            }`}
                                    >
                                        {m === 'code'
                                            ? <><Code2 className="w-4 h-4" /> Paste Code</>
                                            : <><GitPullRequest className="w-4 h-4" /> GitHub PR</>}
                                    </button>
                                ))}
                            </div>

                            {mode === 'code' && (
                                <CodeEditor
                                    value={code}
                                    language={detectedLanguage}
                                    tokenCount={tokenCount}
                                    isOverLimit={isOverLimit}
                                    onChange={(val) => setCode(val ?? '')}
                                />
                            )}
                            
                            {mode === 'pr' && (
                                <PrUrlInput
                                    value={prUrl}
                                    onChange={setPrUrl}
                                    onSubmit={handleReview}
                                    disabled={false}
                                />
                            )}

                            {isOverLimit && mode === 'code' && (
                                <div className="flex items-center gap-2 text-sm text-yellow-400 mt-2">
                                    <AlertTriangle className="w-4 h-4 shrink-0" />
                                    Code exceeds the 8,000 token limit.
                                </div>
                            )}
                        </>
                    ) : (
                        <ReviewInputDisplay type={mode === 'code' ? 'CODE' : 'PR'} input={mode === 'code' ? code : prUrl} />
                    )}
                </div>

                {/* Action row — button when idle, live status when running/complete */}
                <div className="flex items-center gap-4">
                    {!isStreaming && phase !== 'complete' && phase !== 'error' && !isCreatingSession ? (
                        <button
                            onClick={handleReview}
                            disabled={!canSubmit || isLocked}
                            className="group flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-400/40 text-sm cursor-pointer transition-all duration-200 shadow-[0_0_15px_rgba(59,130,246,0.1)] hover:shadow-[0_0_25px_rgba(59,130,246,0.2)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-500/10 disabled:hover:border-blue-500/20 disabled:hover:shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                        >
                            <BrainCircuit className="h-4 w-4 shrink-0 text-blue-400 transition-colors" />
                            <span className="font-medium text-blue-100 transition-colors">
                                Run Review
                            </span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2.5 px-5 py-2.5 border border-blue-500/20 bg-blue-500/5 rounded-lg text-sm shadow-[0_0_15px_rgba(59,130,246,0.05)] transition-all duration-200">
                            <BrainCircuit className={cn(
                                'h-4 w-4 shrink-0 transition-colors',
                                isStreaming || isCreatingSession ? 'text-blue-400/80 animate-pulse' :
                                    phase === 'error' ? 'text-red-500' : 'text-green-500'
                            )} />
                            <span className={`font-medium ${phase === 'complete' || phase === 'error' ? 'text-gray-400' : 'text-blue-200'}`}>
                                {isCreatingSession && 'Starting Session'}
                                {phase === 'connecting' && mode === 'pr' && 'Connecting'}
                                {(phase === 'streaming' || (phase === 'connecting' && mode === 'code') || isCreatingSession) && (
                                    <span className="inline-flex items-center">
                                        <span className="bg-gradient-to-r from-blue-300 to-blue-500 text-transparent bg-clip-text font-semibold tracking-wide">
                                            {isCreatingSession ? '' : 'Running AI Review'}
                                        </span>
                                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400 ml-3" />
                                    </span>
                                )}
                                {phase === 'complete' && 'Review complete'}
                                {phase === 'error' && 'Review failed'}
                            </span>

                            {clusterMap.size > 0 && (
                                <span className="text-gray-500 ml-2 border-l border-gray-700/50 pl-3">
                                    {clusterMap.size} cluster{clusterMap.size !== 1 ? 's' : ''}
                                </span>
                            )}
                            {phase === 'complete' && totalDurationMs != null && (
                                <span className="flex items-center gap-1.5 text-gray-500 ml-2 border-l border-gray-700/50 pl-3">
                                    <Clock className="h-3 w-3" />
                                    {(totalDurationMs / 1000).toFixed(1)}s
                                </span>
                            )}
                        </div>
                    )}
                    {(code || prUrl || review || isLocked) && (
                        <button
                            onClick={startFresh}
                            className="px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 rounded-lg transition-all duration-200 cursor-pointer"
                        >
                            Clear
                        </button>
                    )}
                </div>

                {/* The Execution Pipeline */}
                {activeReviewId && (
                    <div className="mt-8 space-y-6">
                        {(isStreaming || taskItems.length > 0 || traceEntries.length > 0 || clusterMap.size > 0) && (
                            <ReviewProgress
                                entries={traceEntries}
                                taskItems={taskItems}
                                phase={phase}
                                clusterMap={clusterMap}
                                totalDurationMs={totalDurationMs}
                                mode={mode}
                            />
                        )}

                        {review && (
                            <ReviewErrorBoundary onReset={resetStream}>
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
                        )}
                    </div>
                )}
                </>
            )}

                </main>
            </div>

            {/* Fixed input overlay — rendered at page root, outside the scroll container */}
            {review && (
                <ChatInput
                    value={chatInput}
                    onChange={setChatInput}
                    onSubmit={handleSendChat}
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
