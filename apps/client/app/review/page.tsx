'use client'

import dynamic from 'next/dynamic'
import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { detectLanguage, estimateTokens } from '@/lib/detect-language'
import { Loader2, Code2, AlertTriangle } from 'lucide-react'

// Monaco must be loaded client-side only (no SSR)
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

const LANGUAGE_LABELS: Record<string, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    python: 'Python',
    java: 'Java',
    go: 'Go',
    rust: 'Rust',
    html: 'HTML',
    css: 'CSS',
    sql: 'SQL',
    json: 'JSON',
    shell: 'Shell',
    plaintext: 'Plain Text',
}

export default function ReviewPage() {
    const [code, setCode] = useState('')
    const [review, setReview] = useState('')
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

        setReview('')
        setError(null)
        setIsLoading(true)

        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/review/stream`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: code }),
                }
            )

            if (!res.ok) throw new Error(`Server error: ${res.status}`)

            const reader = res.body!.getReader()
            const decoder = new TextDecoder()

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                const raw = decoder.decode(value, { stream: true })
                const lines = raw.split('\n').filter(Boolean)

                for (const line of lines) {
                    if (line.startsWith('0:')) {
                        try {
                            const text = JSON.parse(line.slice(2))
                            setReview((prev) => prev + text)
                        } catch { /* skip malformed chunk */ }
                    }
                }
            }
        } catch (err: unknown) {
            setError(
                err instanceof Error
                    ? err.message
                    : 'Something went wrong. Please try again.'
            )
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="min-h-screen bg-[#0d1117] text-gray-100">
            {/* Top nav bar */}
            <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Code2 className="w-5 h-5 text-blue-400" />
                    <span className="font-semibold text-white">Code Review Agent</span>
                </div>
                <span className="text-xs text-gray-500">Week 1 — Streaming MVP</span>
            </header>

            <main className="max-w-5xl mx-auto p-6 space-y-6">

                {/* Page header */}
                <div>
                    <h1 className="text-2xl font-bold text-white">Review your code</h1>
                    <p className="text-gray-400 text-sm mt-1">
                        Paste or type code below. Language is detected automatically.
                    </p>
                </div>

                {/* Editor section */}
                <div className="space-y-2">
                    {/* Editor header: language badge + token count */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gray-400">Language</span>
                            <span className="px-2 py-0.5 bg-blue-900/40 border border-blue-700/40 
                                rounded text-xs text-blue-300 font-mono">
                                {LANGUAGE_LABELS[detectedLanguage] ?? detectedLanguage}
                            </span>
                        </div>
                        <span className={`text-xs tabular-nums ${isOverLimit ? 'text-red-400' : 'text-gray-500'
                            }`}>
                            {tokenCount.toLocaleString()} / 8,000 tokens
                            {isOverLimit && ' — too long'}
                        </span>
                    </div>

                    {/* Monaco Editor */}
                    <div className="rounded-lg border border-gray-700 overflow-hidden">
                        <MonacoEditor
                            height="320px"
                            language={detectedLanguage}
                            value={code}
                            onChange={handleEditorChange}
                            theme="vs-dark"
                            options={{
                                fontSize: 13,
                                fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
                                fontLigatures: true,
                                minimap: { enabled: false },
                                scrollBeyondLastLine: false,
                                lineNumbers: 'on',
                                roundedSelection: true,
                                padding: { top: 12, bottom: 12 },
                                wordWrap: 'on',
                                automaticLayout: true,
                                tabSize: 2,
                            }}
                        />
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-4">
                    <Button
                        onClick={handleReview}
                        disabled={isLoading || !code.trim() || isOverLimit}
                        className="bg-blue-600 hover:bg-blue-500 text-white px-6"
                    >
                        {isLoading ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Reviewing...
                            </>
                        ) : (
                            'Review Code'
                        )}
                    </Button>
                    {code && (
                        <button
                            onClick={() => { setCode(''); setReview(''); setError(null) }}
                            className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
                        >
                            Clear
                        </button>
                    )}
                </div>

                {/* Token limit warning */}
                {isOverLimit && (
                    <div className="flex items-center gap-2 text-sm text-yellow-400">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        Code exceeds the 8,000 token limit. Please shorten it before reviewing.
                    </div>
                )}

                {/* Error state */}
                {error && (
                    <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 
                        rounded-lg p-4 text-sm text-red-300">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {/* Streaming output */}
                {(review || isLoading) && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <h2 className="text-sm font-medium text-gray-300">Review</h2>
                            {isLoading && (
                                <span className="text-xs text-gray-500 flex items-center gap-1">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Streaming...
                                </span>
                            )}
                        </div>
                        <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 
                            font-mono text-sm text-gray-100 whitespace-pre-wrap leading-relaxed
                            min-h-32 max-h-[480px] overflow-y-auto">
                            {review}
                            {isLoading && (
                                <span className="inline-block w-[7px] h-4 bg-blue-400 ml-0.5 
                                    animate-pulse rounded-sm" />
                            )}
                        </div>
                    </div>
                )}

            </main>
        </div>
    )
}