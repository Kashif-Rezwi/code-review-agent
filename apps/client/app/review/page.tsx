'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Code2, GitPullRequest } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AppHeader } from '@/components/layout/app-header'
import { ErrorBanner } from '@/components/ui/error-banner'
import { CodeEditor } from '@/components/review/code-editor'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { UserBubble, AssistantMessage, LoadingIndicator } from '@/components/review/chat-message'
import { ChatInput } from '@/components/review/chat-input'
import { useChatMessages } from '@/lib/use-chat-messages'
import { detectLanguage, estimateTokens } from '@/lib/detect-language'
import { apiFetch } from '@/lib/api'
import type { ReviewData } from '@/types/review.types'

type Mode = 'code' | 'pr'

export default function ReviewPage() {
    const [mode,     setMode]     = useState<Mode>('code')
    const [code,     setCode]     = useState('')
    const [prUrl,    setPrUrl]    = useState('')
    const [review,   setReview]   = useState<ReviewData | null>(null)
    const [reviewId, setReviewId] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error,    setError]    = useState<string | null>(null)

    const { messages, input, setInput, isSending, submit } = useChatMessages(reviewId)

    const bottomRef = useRef<HTMLDivElement>(null)

    const detectedLanguage = detectLanguage(code)
    const tokenCount       = estimateTokens(code)
    const isOverLimit      = tokenCount > 8000

    const canSubmit =
        mode === 'code'
            ? code.trim().length > 0 && !isOverLimit
            : prUrl.trim().startsWith('https://github.com')

    const handleEditorChange = useCallback((value: string | undefined) => {
        setCode(value ?? '')
    }, [])

    const handleReview = async () => {
        if (!canSubmit || isLoading) return
        setIsLoading(true)
        setError(null)
        setReview(null)
        setReviewId(null)

        try {
            const endpoint = mode === 'code' ? '/review/analyze' : '/review/from-pr'
            const body     = mode === 'code' ? { code } : { prUrl }
            const data     = await apiFetch<ReviewData>(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            setReview(data)
            setReviewId(data.id ?? null)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong.')
        } finally {
            setIsLoading(false)
        }
    }

    const handleClear = () => {
        setCode('')
        setPrUrl('')
        setReview(null)
        setReviewId(null)
        setError(null)
    }

    const handleModeSwitch = (m: Mode) => {
        setMode(m)
        setError(null)
        setReview(null)
        setReviewId(null)
    }

    // Scroll to bottom as the conversation grows
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
                            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                                mode === m ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
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
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                            Pull Request URL
                        </label>
                        <input
                            type="url"
                            value={prUrl}
                            onChange={(e) => setPrUrl(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleReview()}
                            placeholder="https://github.com/owner/repo/pull/123"
                            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3
                                       text-sm text-gray-100 placeholder-gray-600
                                       focus:outline-none focus:border-blue-500 transition-colors"
                        />
                        <p className="text-xs text-gray-600">
                            Public repositories only — private repos require a{' '}
                            <code className="text-gray-500">GITHUB_TOKEN</code> on the server.
                        </p>
                    </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-4">
                    <Button
                        onClick={handleReview}
                        disabled={isLoading || !canSubmit}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-6"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                {mode === 'pr' ? 'Fetching PR...' : 'Analyzing...'}
                            </>
                        ) : (
                            'Review Code'
                        )}
                    </Button>
                    {(code || prUrl || review) && !isLoading && (
                        <button
                            onClick={handleClear}
                            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                        >
                            Clear
                        </button>
                    )}
                </div>

                {/* Warnings */}
                {isOverLimit && mode === 'code' && (
                    <div className="flex items-center gap-2 text-sm text-yellow-400">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Code exceeds the 8,000 token limit.
                    </div>
                )}
                {isLoading && mode === 'pr' && (
                    <div className="flex items-center gap-3 text-sm text-gray-400 bg-gray-900/60 border border-gray-800 rounded-lg px-4 py-3">
                        <Loader2 className="w-4 h-4 animate-spin text-blue-400 shrink-0" />
                        Agent is fetching the PR files and reviewing each one...
                    </div>
                )}

                {error && <ErrorBanner message={error} />}
                {isLoading && <ReviewSkeleton />}

                {/* Review results + follow-up conversation */}
                {!isLoading && review && (
                    <>
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

            {/* Fixed input overlay — appears when user scrolls near the bottom of the review.
                No scrollContainerRef needed: falls back to window scroll for min-h-screen layout. */}
            {reviewId && (
                <ChatInput
                    value={input}
                    onChange={setInput}
                    onSubmit={submit}
                    disabled={isSending}
                />
            )}
        </div>
    )
}
