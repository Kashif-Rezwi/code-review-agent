'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BrainCircuit, Clock, Code2, GitPullRequest, Loader2 } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { PageHeader } from '@/components/layout/page-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { CodeEditor } from '@/components/review/code-editor'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewProgress } from '@/components/review/review-progress'
import { ChatThread } from '@/components/review/chat-thread'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { useReviewStream } from '@/lib/use-review-stream'
import { detectLanguage, estimateTokens, CODE_TOKEN_LIMIT } from '@/lib/detect-language'
import { isValidPrUrl } from '@/lib/validate'
import { PrUrlInput } from '@/components/ui/pr-url-input'
import { ReviewErrorBoundary } from '@/components/ui/error-boundary'
import { cn } from '@/lib/utils'
import { useSession } from 'next-auth/react'

type Mode = 'code' | 'pr'

// Pixels from the bottom at which the user is considered "at bottom" for auto-scroll.
const SCROLL_THRESHOLD = 120

export default function ReviewPage() {
    const [mode, setMode] = useState<Mode>('code')
    const [code, setCode] = useState('')
    const [prUrl, setPrUrl] = useState('')

    const { data: session, status } = useSession()
    const githubToken = session?.githubToken

    const { phase, taskItems, traceEntries, clusterMap, review, error, totalDurationMs, submit, reset } = useReviewStream(githubToken)

    // reviewId drives the follow-up chat — available once complete event arrives.
    const reviewId = review?.id ?? null

    const { messages, input, setInput, isSending, streamingContent, submit: sendChat } = useChatMessages(reviewId, undefined, githubToken)

    const bottomRef = useRef<HTMLDivElement>(null)
    const reviewPanelRef = useRef<HTMLDivElement>(null)
    const chatSectionRef = useRef<HTMLDivElement>(null)
    const isAtBottomRef = useRef(true)           // sync'd by scroll listener, never stale
    const isProgrammaticRef = useRef(false)          // suppresses our own scroll events
    const rafRef = useRef<number | null>(null)  // rAF handle for scroll batching
    const [isAtBottom, setIsAtBottom] = useState(true)     // reactive — drives ↓ Latest pill

    const detectedLanguage = useMemo(() => detectLanguage(code), [code])
    const tokenCount = useMemo(() => estimateTokens(code), [code])
    const isOverLimit = tokenCount > CODE_TOKEN_LIMIT

    const isStreaming = phase === 'connecting' || phase === 'streaming'
    // Lock inputs the moment Review is submitted and keep them locked until Clear is pressed
    const isLocked = isStreaming || phase === 'complete' || phase === 'error'

    const canSubmit =
        mode === 'code'
            ? code.trim().length > 0 && !isOverLimit
            : isValidPrUrl(prUrl)

    const handleEditorChange = useCallback((value: string | undefined) => {
        setCode(value ?? '')
    }, [])

    const handleReview = () => {
        if (!canSubmit || isStreaming) return
        submit(mode === 'code' ? { code } : { prUrl })
    }

    const handleClear = () => {
        setCode('')
        setPrUrl('')
        reset()
    }

    const handleModeSwitch = (m: Mode) => {
        setMode(m)
        reset()
    }

    // Sync isAtBottomRef and isAtBottom; skip our own programmatic scrolls
    useEffect(() => {
        const onScroll = () => {
            if (isProgrammaticRef.current) return
            const { scrollTop, scrollHeight, clientHeight } = document.documentElement
            const atBottom = scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD
            isAtBottomRef.current = atBottom
            setIsAtBottom(atBottom)
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        return () => window.removeEventListener('scroll', onScroll)
    }, [])

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'instant') => {
        isProgrammaticRef.current = true
        bottomRef.current?.scrollIntoView({ behavior })
        // Delay re-enabling user-scroll detection (smooth scroll can take ~300 ms)
        setTimeout(() => { isProgrammaticRef.current = false }, behavior === 'smooth' ? 350 : 50)
    }, [])

    // Re-arm auto-scroll when streaming starts — isAtBottomRef is false while the
    // user is looking at the editor, so without this every trace event skips scrolling
    useEffect(() => {
        if (!isStreaming) return
        isAtBottomRef.current = true
        const id = requestAnimationFrame(() => scrollToBottom('smooth'))
        return () => cancelAnimationFrame(id)
    }, [isStreaming, scrollToBottom])

    // Follow review stream events (trace entries, task items) as they arrive
    useEffect(() => {
        if (!isStreaming || !isAtBottomRef.current) return
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => scrollToBottom('instant'))
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }, [traceEntries, taskItems, isStreaming, scrollToBottom])

    // Scroll to ReviewPanel when review completes — primitive dep fires exactly once per review;
    // rAF defers past the layout shift so ReviewPanel is in the DOM before we scroll
    useEffect(() => {
        if (!reviewId) return
        const id = requestAnimationFrame(() => {
            reviewPanelRef.current?.scrollIntoView({ behavior: 'smooth' })
        })
        return () => cancelAnimationFrame(id)
    }, [reviewId])

    // Follow chat streaming tokens; rAF batches rapid updates into one scroll per frame
    useEffect(() => {
        if (streamingContent === null || !isAtBottomRef.current) return
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => scrollToBottom('instant'))
        return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
    }, [streamingContent, scrollToBottom])

    // Scroll to bottom when a settled chat message is appended.
    useEffect(() => {
        if (messages.length === 0) return
        if (isAtBottomRef.current) scrollToBottom('smooth')
    }, [messages, scrollToBottom])

    // Force auto-scroll when sending so the response is always visible
    const handleSendChat = useCallback(async () => {
        isAtBottomRef.current = true
        scrollToBottom('smooth')
        await sendChat()
    }, [sendChat, scrollToBottom])

    return (
        <div className="min-h-screen bg-app-bg text-gray-100">
            <AppHeader />

            {/* pb-24 ensures content is never obscured by the fixed input overlay */}
            <main className="max-w-4xl mx-auto p-6 pb-24 space-y-6">
                <PageHeader
                    title="Review your code"
                    description="Paste code directly or provide a GitHub PR URL."
                />

                {/* Mode tabs */}
                <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
                    {(['code', 'pr'] as Mode[]).map((m) => (
                        <button
                            key={m}
                            onClick={() => !isLocked && handleModeSwitch(m)}
                            disabled={isLocked}
                            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${mode === m
                                ? 'bg-blue-500/15 text-blue-100 border border-blue-500/25 shadow-[0_0_10px_rgba(59,130,246,0.12)]'
                                : 'text-gray-500 hover:text-gray-300 border border-transparent'
                                } ${isLocked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                        >
                            {m === 'code'
                                ? <><Code2 className="w-4 h-4" /> Paste Code</>
                                : <><GitPullRequest className="w-4 h-4" /> GitHub PR</>}
                        </button>
                    ))}
                </div>

                {/* Input */}
                {mode === 'code' ? (
                    <CodeEditor
                        value={code}
                        language={detectedLanguage}
                        tokenCount={tokenCount}
                        isOverLimit={isOverLimit}
                        onChange={isLocked ? undefined : handleEditorChange}
                        readOnly={isLocked}
                    />
                ) : (
                    <PrUrlInput
                        value={prUrl}
                        onChange={setPrUrl}
                        onSubmit={handleReview}
                        disabled={isStreaming || isLocked}
                    />
                )}

                {/* Token warning */}
                {isOverLimit && mode === 'code' && (
                    <div className="flex items-center gap-2 text-sm text-yellow-400">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Code exceeds the 8,000 token limit.
                    </div>
                )}

                {/* Action row — button when idle, live status when running/complete */}
                <div className="flex items-center gap-4">
                    {!isStreaming && phase !== 'complete' && phase !== 'error' ? (
                        <button
                            onClick={handleReview}
                            disabled={!canSubmit}
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
                                isStreaming ? 'text-blue-400/80 animate-pulse' :
                                    phase === 'error' ? 'text-red-500' : 'text-green-500'
                            )} />
                            <span className={`font-medium ${phase === 'complete' || phase === 'error' ? 'text-gray-400' : 'text-blue-200'}`}>
                                {phase === 'connecting' && mode === 'pr' && 'Connecting'}
                                {(phase === 'streaming' || (phase === 'connecting' && mode === 'code')) && (
                                    <span className="inline-flex items-center">
                                        <span className="bg-gradient-to-r from-blue-300 to-blue-500 text-transparent bg-clip-text font-semibold tracking-wide">Running AI Review</span>
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
                            onClick={handleClear}
                            className="px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 rounded-lg transition-all duration-200 cursor-pointer"
                        >
                            Clear
                        </button>
                    )}
                </div>

                {/* Error */}
                {error && <ErrorBanner message={error} />}

                {/* Agent trace pipeline — visible during streaming AND persists after completion */}
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

                {/* Review results + follow-up conversation */}
                {review && (
                    <ReviewErrorBoundary onReset={reset}>
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

                {/* Scroll anchor — outside {review &&} so it exists during review streaming */}
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
