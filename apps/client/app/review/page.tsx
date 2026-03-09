'use client'

import { useCallback, useState } from 'react'
import { AlertTriangle, Loader2, Code2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CodeEditor } from '@/components/review/code-editor'
import { ReviewPanel } from '@/components/review/review-panel'
import { ReviewSkeleton } from '@/components/review/review-skeleton'
import { detectLanguage, estimateTokens } from '@/lib/detect-language'
import type { ReviewData } from '@/types/review.types'

export default function ReviewPage() {
    const [code, setCode] = useState('')
    const [review, setReview] = useState<ReviewData | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const detectedLanguage = detectLanguage(code)
    const tokenCount = estimateTokens(code)
    const isOverLimit = tokenCount > 8000

    const handleEditorChange = useCallback((value: string | undefined) => {
        setCode(value ?? '')
    }, [])

    const handleReview = async () => {
        if (!code.trim() || isOverLimit) return
        setIsLoading(true)
        setError(null)
        setReview(null)

        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/review/analyze`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code }),
                }
            )

            if (!res.ok) {
                const msg = await res.text()
                throw new Error(msg || 'Review failed. Please try again.')
            }

            const data: ReviewData = await res.json()
            setReview(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong.')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Code2 className="w-5 h-5 text-blue-400" />
                    <span className="font-semibold text-white">Code Review Agent</span>
                </div>
                <span className="text-xs text-gray-500">Week 2 — Structured Output</span>
            </header>

            <main className="max-w-5xl mx-auto p-6 space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white">Review your code</h1>
                    <p className="text-gray-400 text-sm mt-1">
                        Paste or type code below. Language is detected automatically.
                    </p>
                </div>

                <CodeEditor
                    value={code}
                    language={detectedLanguage}
                    tokenCount={tokenCount}
                    isOverLimit={isOverLimit}
                    onChange={handleEditorChange}
                />

                <div className="flex items-center gap-4">
                    <Button
                        onClick={handleReview}
                        disabled={isLoading || !code.trim() || isOverLimit}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-6"
                    >
                        {isLoading
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing...</>
                            : 'Review Code'}
                    </Button>
                    {(code || review) && !isLoading && (
                        <button
                            onClick={() => { setCode(''); setReview(null); setError(null) }}
                            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                        >
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
                        {error}
                    </div>
                )}

                {isLoading && <ReviewSkeleton />}

                {!isLoading && review && <ReviewPanel review={review} />}
            </main>
        </div>
    )
}