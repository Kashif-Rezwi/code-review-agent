'use client'

import { useCallback, useMemo } from 'react'
import { useCompletion } from '@ai-sdk/react'
import { AlertTriangle, Loader2, Code2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CodeEditor } from '@/components/review/code-editor'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { parseReview } from '@/lib/parse-review'
import { detectLanguage, estimateTokens } from '@/lib/detect-language'

export default function ReviewPage() {
    const { completion, input, setInput, isLoading, error, complete } = useCompletion({
        api: `${process.env.NEXT_PUBLIC_API_URL}/review/stream`,
        streamProtocol: 'text',
    })

    const detectedLanguage = detectLanguage(input)
    const tokenCount = estimateTokens(input)
    const isOverLimit = tokenCount > 8000

    const review = useMemo(
        () => (!isLoading && completion ? parseReview(completion) : null),
        [isLoading, completion]
    )

    const handleEditorChange = useCallback((value: string | undefined) => {
        setInput(value ?? '')
    }, [setInput])

    const handleReview = () => {
        if (!input.trim() || isOverLimit) return
        complete(input)
    }

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Code2 className="w-5 h-5 text-blue-400" />
                    <span className="font-semibold text-white">Code Review Agent</span>
                </div>
                <span className="text-xs text-gray-500">Week 1 — Streaming MVP</span>
            </header>

            <main className="max-w-5xl mx-auto p-6 space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white">Review your code</h1>
                    <p className="text-gray-400 text-sm mt-1">Paste or type code below. Language is detected automatically.</p>
                </div>

                <CodeEditor
                    value={input}
                    language={detectedLanguage}
                    tokenCount={tokenCount}
                    isOverLimit={isOverLimit}
                    onChange={handleEditorChange}
                />

                {/* Actions */}
                <div className="flex items-center gap-4">
                    <Button onClick={handleReview} disabled={isLoading || !input.trim() || isOverLimit}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-6">
                        {isLoading
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Reviewing...</>
                            : 'Review Code'}
                    </Button>
                    {input && !isLoading && (
                        <button onClick={() => setInput('')}
                            className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
                            Clear
                        </button>
                    )}
                </div>

                {isOverLimit && (
                    <div className="flex items-center gap-2 text-sm text-yellow-400">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Code exceeds the 8,000 token limit.
                    </div>
                )}

                {error && (
                    <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 rounded-lg p-4 text-sm text-red-300">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        {error.message}
                    </div>
                )}

                {isLoading && <ReviewSkeleton />}

                {!isLoading && review && <ReviewPanel review={review} />}

                {/* Fallback: raw text if JSON parse failed */}
                {!isLoading && completion && !review && (
                    <div className="rounded-xl border border-gray-700 bg-gray-900 p-5 font-mono text-sm
                        text-gray-100 whitespace-pre-wrap leading-relaxed max-h-[480px] overflow-y-auto">
                        {completion}
                    </div>
                )}
            </main>
        </div>
    )
}