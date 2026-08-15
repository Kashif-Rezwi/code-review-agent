'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { CodeEditor } from '@/components/review/code-editor'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewProgress } from '@/components/review/review-progress'
import { ChatThread } from '@/components/review/chat-thread'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { useReviewStream } from '@/lib/use-review-stream'
import { reviewService } from '@/lib/api'
import { detectLanguage, estimateTokens, CODE_TOKEN_LIMIT } from '@/lib/detect-language'
import { isValidPrUrl } from '@/lib/validate'
import { PrUrlInput } from '@/components/ui/pr-url-input'
import { ReviewHeader } from '@/components/review/review-header'
import { ReviewActionContainer } from '@/components/review/review-action-container'
import { ReviewErrorBoundary } from '@/components/ui/error-boundary'
import { useReviewScroll } from '@/lib/hooks/use-review-scroll'
import { useSession } from 'next-auth/react'
import { useWallet } from '@/lib/use-wallet'

type Mode = 'code' | 'pr'

export function ReviewPageClient({ initialReviewType, initialReviewId }: { initialReviewType?: string; initialReviewId?: string }) {
    const router = useRouter()
    const defaultMode = initialReviewType === 'github_pr' ? 'pr' : 'code'
    const [mode, setMode] = useState<Mode>(defaultMode)
    const [code, setCode] = useState('')
    const [prUrl, setPrUrl] = useState('')

    const { data: session } = useSession()
    const githubToken = session?.githubToken
    const { balance, refresh: refreshWallet } = useWallet(githubToken)

    const {
        phase, taskItems, traceEntries, clusterMap, sessionData, review, error,
        totalDurationMs, acquisition, outcome, synthesisStarted, submit, reset,
    } = useReviewStream(initialReviewId, githubToken)

    // Refresh wallet on complete or error to reflect deductions/refunds
    useEffect(() => {
        if (phase === 'complete' || phase === 'error') {
            void refreshWallet()
        }
    }, [phase, refreshWallet])

    const isStreaming = phase === 'connecting' || phase === 'streaming'
    const { bottomRef, contentRef, scrollToBottom, isAtBottom, isAtBottomRef } = useReviewScroll({ isStreaming })
    const displayedCode = sessionData?.type === 'CODE' ? sessionData.input : code
    const displayedPrUrl = sessionData?.type === 'PR' ? sessionData.input : prUrl

    // reviewId drives the follow-up chat — available once complete event arrives.
    const reviewId = review?.id ?? null
    const { messages, input, setInput, isSending, streamingContent, submit: sendChat } = useChatMessages(reviewId, undefined, githubToken)

    const reviewPanelRef = useRef<HTMLDivElement>(null)
    const chatSectionRef = useRef<HTMLDivElement>(null)
    const rafRef = useRef<number | null>(null)

    const detectedLanguage = useMemo(() => detectLanguage(displayedCode), [displayedCode])
    const tokenCount = useMemo(() => estimateTokens(displayedCode), [displayedCode])
    const isOverLimit = tokenCount > CODE_TOKEN_LIMIT

    // Lock inputs if there's an initial ID or if we are streaming/complete/error
    const isLocked = !!initialReviewId || isStreaming || phase === 'complete' || phase === 'error'

    const creditCost = mode === 'code' ? 5 : 10
    const hasSufficientCredits = session?.user ? balance >= creditCost : true

    const canSubmit =
        (mode === 'code'
            ? displayedCode.trim().length > 0 && !isOverLimit
            : isValidPrUrl(displayedPrUrl)) && hasSufficientCredits

    const handleEditorChange = useCallback((value: string | undefined) => {
        setCode(value ?? '')
    }, [])

    const handleReview = async () => {
        if (!canSubmit || isStreaming) return
        const id = await submit(mode === 'code' ? { code: displayedCode } : { prUrl: displayedPrUrl })
        if (id) {
            router.push(`/review/${mode === 'code' ? 'paste_code' : 'github_pr'}/${id}`)
        }
    }

    const handleClear = useCallback(async () => {
        if (isStreaming && initialReviewId) {
            // Fire-and-forget the cancel request (server marks the DB CANCELLED + emits a terminal
            // Redis event); reset the local stream immediately so the UI stays responsive.
            reviewService.cancelSession(initialReviewId, githubToken).catch((err) => {
                console.warn('[review] cancel request failed — job may still run to completion', err)
            })
            reset()
            router.push(`/review/${mode === 'code' ? 'paste_code' : 'github_pr'}`)
            return
        }

        if (initialReviewId) {
            router.push(`/review/${mode === 'code' ? 'paste_code' : 'github_pr'}`)
            return
        }

        setCode('')
        setPrUrl('')
        reset()
    }, [isStreaming, initialReviewId, githubToken, reset, router, mode])

    const handleModeSwitch = (m: Mode) => {
        if (isLocked) return
        setMode(m)
        reset()
        window.history.replaceState({}, '', `/review/${m === 'code' ? 'paste_code' : 'github_pr'}`)
    }

    // Re-arm auto-scroll when streaming starts
    useEffect(() => {
        if (!isStreaming) return
        isAtBottomRef.current = true
        const id = requestAnimationFrame(() => scrollToBottom('smooth'))
        return () => cancelAnimationFrame(id)
    }, [isStreaming, scrollToBottom, isAtBottomRef])

    // Follow review stream events (trace entries, task items) as they arrive
    useEffect(() => {
        if (!isStreaming || !isAtBottomRef.current) return
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => scrollToBottom('instant'))
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }, [traceEntries, taskItems, clusterMap, isStreaming, scrollToBottom, isAtBottomRef])

    // Scroll to ReviewPanel when review completes
    useEffect(() => {
        if (!reviewId) return
        const timer = setTimeout(() => {
            reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth' })
        }, 300)
        return () => clearTimeout(timer)
    }, [reviewId])

    // Follow chat streaming tokens
    useEffect(() => {
        if (streamingContent === null || !isAtBottomRef.current) return
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => scrollToBottom('instant'))
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }, [streamingContent, scrollToBottom, isAtBottomRef])

    // Scroll to bottom when a settled chat message is appended.
    useEffect(() => {
        if (messages.length === 0) return
        if (isAtBottomRef.current) scrollToBottom('smooth')
    }, [messages, scrollToBottom, isAtBottomRef])

    const handleSendChat = useCallback(async () => {
        isAtBottomRef.current = true
        scrollToBottom('smooth')
        await sendChat()
    }, [sendChat, scrollToBottom, isAtBottomRef])

    return (
        <div className="min-h-screen bg-app-bg text-gray-100">
            <AppHeader />

            <main ref={contentRef} className="max-w-4xl mx-auto p-6 pb-24 space-y-6">
                <ReviewHeader
                    mode={mode}
                    isLocked={isLocked}
                    balance={session?.user ? balance : undefined}
                    onModeSwitch={handleModeSwitch}
                />

                {mode === 'code' ? (
                    <CodeEditor
                        value={displayedCode}
                        language={detectedLanguage}
                        tokenCount={tokenCount}
                        isOverLimit={isOverLimit}
                        onChange={isLocked ? undefined : handleEditorChange}
                        readOnly={isLocked}
                        isLoading={!!initialReviewId && !sessionData}
                    />
                ) : (
                    <PrUrlInput
                        value={displayedPrUrl}
                        onChange={setPrUrl}
                        onSubmit={handleReview}
                        disabled={isLocked}
                        isLoading={!!initialReviewId && !sessionData}
                    />
                )}

                {isOverLimit && mode === 'code' && (
                    <div className="flex items-center gap-2 text-sm text-yellow-400">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Code exceeds the 8,000 token limit.
                    </div>
                )}

                <ReviewActionContainer
                    phase={phase}
                    isStreaming={isStreaming}
                    clusterMapSize={clusterMap.size}
                    totalDurationMs={totalDurationMs}
                    outcome={outcome}
                    canSubmit={canSubmit}
                    hasAnyInput={!!(displayedCode || displayedPrUrl || review || isLocked)}
                    creditCost={creditCost}
                    balance={balance}
                    hasSufficientCredits={hasSufficientCredits}
                    handleReview={handleReview}
                    handleClear={handleClear}
                />


                {error && <ErrorBanner message={error} />}

                {(isStreaming || taskItems.length > 0 || traceEntries.length > 0 || clusterMap.size > 0) && (
                    <ReviewProgress
                        entries={traceEntries}
                        taskItems={taskItems}
                        phase={phase}
                        clusterMap={clusterMap}
                        totalDurationMs={totalDurationMs}
                        mode={mode}
                        acquisition={acquisition}
                        outcome={outcome}
                        synthesisStarted={synthesisStarted}
                    />
                )}

                {review && (
                    <ReviewErrorBoundary onReset={reset}>
                        <div ref={reviewPanelRef} className="scroll-mt-20">
                            <ReviewPanel review={review} />
                        </div>
                        <div ref={chatSectionRef}>
                            <ReviewErrorBoundary onReset={reset}>
                                <ChatThread
                                    messages={messages}
                                    streamingContent={streamingContent}
                                    isSending={isSending}
                                />
                            </ReviewErrorBoundary>
                        </div>
                    </ReviewErrorBoundary>
                )}

                <div ref={bottomRef} />
            </main>

            {reviewId && (
                <ChatInput
                    value={input}
                    onChange={setInput}
                    onSubmit={handleSendChat}
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
