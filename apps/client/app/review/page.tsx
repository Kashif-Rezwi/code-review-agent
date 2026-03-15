'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BrainCircuit, Clock, Code2, GitPullRequest } from 'lucide-react'
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
    const tokenCount       = useMemo(() => estimateTokens(code),  [code])
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
                            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${mode === m ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
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
                            className="flex items-center gap-2 text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed group"
                        >
                            <BrainCircuit className="h-4 w-4 shrink-0 text-blue-400 group-hover:text-blue-300 transition-colors" />
                            <span className="font-medium text-gray-300 group-hover:text-white transition-colors">
                                {mode === 'pr' ? 'Run Agents' : 'Run Review'}
                            </span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2 text-sm">
                            <BrainCircuit className={`h-4 w-4 shrink-0 ${phase === 'complete' || phase === 'error' ? 'text-green-500' : 'text-blue-400'}`} />
                            <span className={`font-medium ${phase === 'complete' || phase === 'error' ? 'text-gray-400' : 'text-gray-300'}`}>
                                {phase === 'connecting' && 'Connecting to agent…'}
                                {phase === 'streaming' && 'Agent is analysing…'}
                                {phase === 'complete' && 'Agent trace'}
                                {phase === 'error' && 'Agent trace (error)'}
                            </span>
                            {isStreaming && <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />}
                            {clusterMap.size > 0 && (
                                <span className="text-gray-600">
                                    {clusterMap.size} cluster{clusterMap.size !== 1 ? 's' : ''}
                                </span>
                            )}
                            {phase === 'complete' && totalDurationMs != null && (
                                <span className="flex items-center gap-1 text-gray-600">
                                    <Clock className="h-3 w-3" />
                                    {(totalDurationMs / 1000).toFixed(1)}s
                                </span>
                            )}
                        </div>
                    )}
                    {(code || prUrl || review) && !isStreaming && (
                        <button
                            onClick={handleClear}
                            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
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
