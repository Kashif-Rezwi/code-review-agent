'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BrainCircuit, Clock, Code2, GitPullRequest, Loader2, Bot } from 'lucide-react'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { CodeEditor } from '@/components/review/code-editor'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewProgress } from '@/components/review/review-progress'
import { UserBubble, AssistantMessage, LoadingIndicator } from '@/components/review/chat-message'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { useReviewStream } from '@/lib/use-review-stream'
import { detectLanguage, estimateTokens, CODE_TOKEN_LIMIT } from '@/lib/detect-language'
import { PrUrlInput } from '@/components/ui/pr-url-input'
import { ReviewErrorBoundary } from '@/components/ui/error-boundary'
import { cn } from '@/lib/utils'

type Mode = 'code' | 'pr'

export default function ReviewPage() {
    const [mode, setMode] = useState<Mode>('code')
    const [code, setCode] = useState('')
    const [prUrl, setPrUrl] = useState('')

    const { phase, taskItems, traceEntries, clusterMap, review, error, totalDurationMs, submit, reset } = useReviewStream()

    // reviewId drives the follow-up chat — available once complete event arrives.
    const reviewId = review?.id ?? null

    const { messages, input, setInput, isSending, submit: sendChat } = useChatMessages(reviewId)

    const bottomRef = useRef<HTMLDivElement>(null)

    // Memoize so language detection and token counting only re-run when `code` changes,
    // not on every SSE event or unrelated state update.
    const detectedLanguage = useMemo(() => detectLanguage(code), [code])
    const tokenCount = useMemo(() => estimateTokens(code), [code])
    const isOverLimit = tokenCount > CODE_TOKEN_LIMIT

    const isStreaming = phase === 'connecting' || phase === 'streaming'

    const canSubmit =
        mode === 'code'
            ? code.trim().length > 0 && !isOverLimit
            : /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(prUrl.trim())

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

    // Scroll to bottom as the conversation grows.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages, isSending])

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            <AppHeader />

            {/* pb-24 ensures content is never obscured by the fixed input overlay */}
            <main className="max-w-5xl mx-auto p-6 pb-24 space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white">Review your code</h1>
                    <p className="text-gray-400 text-sm mt-1">
                        Paste code directly or provide a GitHub PR URL.
                    </p>
                </div>

                {/* Mode tabs */}
                <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
                    {(['code', 'pr'] as Mode[]).map((m) => (
                        <button
                            key={m}
                            onClick={() => handleModeSwitch(m)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 ${
                                mode === m
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

                {/* Input */}
                {mode === 'code' ? (
                    <CodeEditor
                        value={code}
                        language={detectedLanguage}
                        tokenCount={tokenCount}
                        isOverLimit={isOverLimit}
                        onChange={handleEditorChange}
                    />
                ) : (
                    <PrUrlInput
                        value={prUrl}
                        onChange={setPrUrl}
                        onSubmit={handleReview}
                        disabled={isStreaming}
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
                            className="group flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-400/40 text-sm cursor-pointer transition-all duration-300 shadow-[0_0_15px_rgba(59,130,246,0.1)] hover:shadow-[0_0_25px_rgba(59,130,246,0.2)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-500/10 disabled:hover:border-blue-500/20 disabled:hover:shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                        >
                            <BrainCircuit className="h-4 w-4 shrink-0 text-blue-400 transition-colors" />
                            <span className="font-medium text-blue-100 transition-colors">
                                Run Review
                            </span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2.5 px-5 py-2.5 border border-blue-500/20 bg-blue-500/5 rounded-lg text-sm shadow-[0_0_15px_rgba(59,130,246,0.05)] transition-all duration-300">
                            <BrainCircuit className={cn(
                                'h-4 w-4 shrink-0 transition-colors',
                                isStreaming ? 'text-blue-400/80 animate-pulse' :
                                    phase === 'error' ? 'text-red-500' : 'text-green-500'
                            )} />
                            <span className={`font-medium ${phase === 'complete' || phase === 'error' ? 'text-gray-400' : 'text-blue-200'}`}>
                                {phase === 'connecting' && mode === 'pr' && 'Connecting'}
                                {(phase === 'streaming' || (phase === 'connecting' && mode === 'code')) && (
                                    <span className="inline-flex items-center">
                                        <span className="bg-gradient-to-r from-blue-400 to-indigo-400 text-transparent bg-clip-text font-semibold tracking-wide">Running AI Review</span>
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
                    {(code || prUrl || review) && !isStreaming && (
                        <button
                            onClick={handleClear}
                            className="px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 rounded-lg transition-all duration-300 cursor-pointer"
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
                        <ReviewPanel review={review} />

                        {/* Messages — keyed by index (safe: list is append-only) */}
                        {messages.map((msg, i) =>
                            msg.role === 'user'
                                ? <UserBubble key={i} content={msg.content} />
                                : <AssistantMessage key={i} content={msg.content} />
                        )}

                        {isSending && <LoadingIndicator />}
                        <div ref={bottomRef} />
                    </ReviewErrorBoundary>
                )}
            </main>

            {/* Fixed input overlay — appears when user scrolls near the bottom of the review.
                No scrollContainerRef needed: falls back to window scroll for min-h-screen layout. */}
            {reviewId && (
                <ChatInput
                    value={input}
                    onChange={setInput}
                    onSubmit={sendChat}
                    disabled={isSending}
                />
            )}
        </div>
    )
}
