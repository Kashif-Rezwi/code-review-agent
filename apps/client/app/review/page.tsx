'use client'

import dynamic from 'next/dynamic'
import { useCallback, useMemo } from 'react'
import { useCompletion } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import { detectLanguage, estimateTokens } from '@/lib/detect-language'
import {
    Loader2, Code2, AlertTriangle, AlertCircle,
    Info, Zap, Shield, Wrench, Lightbulb,
    CheckCircle2, XCircle, ChevronRight
} from 'lucide-react'
import { cn } from '@/lib/utils'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReviewIssue {
    type: 'bug' | 'security' | 'performance' | 'style' | 'suggestion'
    severity: 'critical' | 'warning' | 'info'
    title: string
    location: string
    description: string
    recommendation: string
}

interface ReviewData {
    summary: string
    score: number
    issues: ReviewIssue[]
    positives: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LANGUAGE_LABELS: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
    java: 'Java', go: 'Go', rust: 'Rust', html: 'HTML', css: 'CSS',
    sql: 'SQL', json: 'JSON', shell: 'Shell', plaintext: 'Plain Text',
}

const TYPE_CONFIG = {
    bug: { icon: XCircle, label: 'Bug', color: 'text-red-400', bg: 'bg-red-950/40 border-red-800/50' },
    security: { icon: Shield, label: 'Security', color: 'text-orange-400', bg: 'bg-orange-950/40 border-orange-800/50' },
    performance: { icon: Zap, label: 'Performance', color: 'text-yellow-400', bg: 'bg-yellow-950/40 border-yellow-800/50' },
    style: { icon: Wrench, label: 'Style', color: 'text-blue-400', bg: 'bg-blue-950/40 border-blue-800/50' },
    suggestion: { icon: Lightbulb, label: 'Suggestion', color: 'text-purple-400', bg: 'bg-purple-950/40 border-purple-800/50' },
}

const SEVERITY_CONFIG = {
    critical: { label: 'Critical', badge: 'bg-red-900/60 text-red-300 border-red-700/60' },
    warning: { label: 'Warning', badge: 'bg-yellow-900/60 text-yellow-300 border-yellow-700/60' },
    info: { label: 'Info', badge: 'bg-gray-800 text-gray-400 border-gray-700' },
}

function parseReview(raw: string): ReviewData | null {
    if (!raw.trim()) return null
    try {
        // Strip markdown code fences if present: ```json ... ```
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
        return JSON.parse(cleaned) as ReviewData
    } catch {
        return null
    }
}

function ScoreRing({ score }: { score: number }) {
    const color = score >= 8 ? '#22c55e' : score >= 5 ? '#eab308' : '#ef4444'
    const r = 28, circ = 2 * Math.PI * r
    const dash = (score / 10) * circ

    return (
        <div className="relative flex items-center justify-center w-16 h-16">
            <svg width="64" height="64" className="-rotate-90">
                <circle cx="32" cy="32" r={r} fill="none" stroke="#1f2937" strokeWidth="5" />
                <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="5"
                    strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 0.6s ease' }} />
            </svg>
            <span className="absolute text-sm font-bold text-white">{score}<span className="text-xs text-gray-400">/10</span></span>
        </div>
    )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ReviewPage() {
    const { completion, input, setInput, isLoading, error, complete } = useCompletion({
        api: `${process.env.NEXT_PUBLIC_API_URL}/review/stream`,
        streamProtocol: 'text',
    })

    const detectedLanguage = detectLanguage(input)
    const tokenCount = estimateTokens(input)
    const isOverLimit = tokenCount > 8000

    // Parse the review JSON only once streaming is complete
    const review = useMemo<ReviewData | null>(
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
            {/* Nav */}
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

                {/* Editor */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gray-400">Language</span>
                            <span className="px-2 py-0.5 bg-blue-900/40 border border-blue-700/40 rounded text-xs text-blue-300 font-mono">
                                {LANGUAGE_LABELS[detectedLanguage] ?? detectedLanguage}
                            </span>
                        </div>
                        <span className={cn('text-xs tabular-nums', isOverLimit ? 'text-red-400' : 'text-gray-500')}>
                            {tokenCount.toLocaleString()} / 8,000 tokens{isOverLimit && ' — too long'}
                        </span>
                    </div>
                    <div className="rounded-lg border border-gray-700 overflow-hidden">
                        <MonacoEditor
                            height="300px"
                            language={detectedLanguage}
                            value={input}
                            onChange={handleEditorChange}
                            theme="vs-dark"
                            options={{
                                fontSize: 13,
                                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                                minimap: { enabled: false },
                                scrollBeyondLastLine: false,
                                lineNumbers: 'on',
                                padding: { top: 12, bottom: 12 },
                                wordWrap: 'on',
                                automaticLayout: true,
                            }}
                        />
                    </div>
                </div>

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

                {/* Error */}
                {error && (
                    <div className="flex items-start gap-3 bg-red-950/50 border border-red-800 rounded-lg p-4 text-sm text-red-300">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        {error.message}
                    </div>
                )}

                {/* Streaming skeleton */}
                {isLoading && (
                    <div className="rounded-xl border border-gray-700 bg-gray-900/50 p-6 space-y-4">
                        <div className="flex items-center gap-3">
                            <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                            <span className="text-sm text-gray-400">Analyzing your code...</span>
                        </div>
                        <div className="space-y-2 animate-pulse">
                            <div className="h-3 bg-gray-800 rounded w-3/4" />
                            <div className="h-3 bg-gray-800 rounded w-1/2" />
                            <div className="h-3 bg-gray-800 rounded w-2/3" />
                        </div>
                    </div>
                )}

                {/* Structured review */}
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

// ─── ReviewPanel ──────────────────────────────────────────────────────────────

function ReviewPanel({ review }: { review: ReviewData }) {
    const criticalCount = review.issues.filter(i => i.severity === 'critical').length
    const warningCount = review.issues.filter(i => i.severity === 'warning').length

    return (
        <div className="space-y-4">
            {/* Header card: score + summary */}
            <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-5 flex items-start gap-5">
                <ScoreRing score={review.score} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                        <h2 className="text-sm font-semibold text-white">Overall Assessment</h2>
                        {criticalCount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-red-900/60 text-red-300 border border-red-700/60">
                                {criticalCount} critical
                            </span>
                        )}
                        {warningCount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-yellow-900/60 text-yellow-300 border border-yellow-700/60">
                                {warningCount} warning{warningCount > 1 ? 's' : ''}
                            </span>
                        )}
                        {review.issues.length === 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs bg-green-900/60 text-green-300 border border-green-700/60">
                                No issues found
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-gray-300 leading-relaxed">{review.summary}</p>
                </div>
            </div>

            {/* Issues */}
            {review.issues.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">
                        Issues ({review.issues.length})
                    </h3>
                    {review.issues.map((issue, i) => (
                        <IssueCard key={i} issue={issue} />
                    ))}
                </div>
            )}

            {/* Positives */}
            {review.positives.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">
                        What's good
                    </h3>
                    <div className="rounded-xl border border-green-900/40 bg-green-950/20 p-4 space-y-2">
                        {review.positives.map((p, i) => (
                            <div key={i} className="flex items-start gap-2 text-sm text-green-300">
                                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-500" />
                                <span>{p}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

function IssueCard({ issue }: { issue: ReviewIssue }) {
    const typeConf = TYPE_CONFIG[issue.type] ?? TYPE_CONFIG.suggestion
    const sevConf = SEVERITY_CONFIG[issue.severity] ?? SEVERITY_CONFIG.info
    const Icon = typeConf.icon

    return (
        <div className={cn('rounded-xl border p-4 space-y-3', typeConf.bg)}>
            {/* Issue header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <Icon className={cn('w-4 h-4 shrink-0', typeConf.color)} />
                    <span className="text-sm font-medium text-white">{issue.title}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={cn('px-2 py-0.5 rounded text-xs border font-medium', sevConf.badge)}>
                        {sevConf.label}
                    </span>
                    <span className="px-2 py-0.5 rounded text-xs border bg-gray-800 text-gray-400 border-gray-700">
                        {typeConf.label}
                    </span>
                </div>
            </div>

            {/* Location */}
            {issue.location && (
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                    <ChevronRight className="w-3 h-3" />
                    <span className="font-mono">{issue.location}</span>
                </div>
            )}

            {/* Description */}
            <p className="text-sm text-gray-300 leading-relaxed">{issue.description}</p>

            {/* Recommendation */}
            {issue.recommendation && (
                <div className="flex items-start gap-2 bg-black/20 rounded-lg p-3">
                    <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-400" />
                    <p className="text-xs text-gray-300 leading-relaxed">
                        <span className="text-blue-400 font-medium">Fix: </span>
                        {issue.recommendation}
                    </p>
                </div>
            )}
        </div>
    )
}