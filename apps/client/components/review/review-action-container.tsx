'use client'

import { BrainCircuit, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReviewActionContainerProps {
    phase: string
    isStreaming: boolean
    mode: 'code' | 'pr'
    clusterMapSize: number
    totalDurationMs: number | null
    canSubmit: boolean
    hasAnyInput: boolean
    isLocked: boolean
    handleReview: () => void
    handleClear: () => void
}

export function ReviewActionContainer({
    phase,
    isStreaming,
    mode,
    clusterMapSize,
    totalDurationMs,
    canSubmit,
    hasAnyInput,
    isLocked,
    handleReview,
    handleClear,
}: ReviewActionContainerProps) {
    return (
        <div className="flex items-center gap-4">
            {!isStreaming && phase !== 'complete' && phase !== 'error' ? (
                <button
                    onClick={handleReview}
                    disabled={!canSubmit}
                    className="group flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-400/40 text-sm cursor-pointer transition-all duration-200 shadow-[0_0_15px_rgba(59,130,246,0.1)] hover:shadow-[0_0_25px_rgba(59,130,246,0.2)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-500/10 disabled:hover:border-blue-500/20 disabled:hover:shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                >
                    <BrainCircuit className="h-4 w-4 shrink-0 text-blue-400 transition-colors" />
                    <span className="font-medium text-blue-100 transition-colors">Run Review</span>
                </button>
            ) : (
                <div className="flex items-center gap-2.5 px-5 py-2.5 border border-blue-500/20 bg-blue-500/5 rounded-lg text-sm shadow-[0_0_15px_rgba(59,130,246,0.05)] transition-all duration-200">
                    <BrainCircuit
                        className={cn(
                            'h-4 w-4 shrink-0 transition-colors',
                            isStreaming
                                ? 'text-blue-400/80 animate-pulse'
                                : phase === 'error'
                                ? 'text-red-500'
                                : 'text-green-500'
                        )}
                    />
                    <span
                        className={`font-medium ${
                            phase === 'complete' || phase === 'error' ? 'text-gray-400' : 'text-blue-200'
                        }`}
                    >
                        {phase === 'connecting' && mode === 'pr' && 'Connecting'}
                        {(phase === 'streaming' || (phase === 'connecting' && mode === 'code')) && (
                            <span className="inline-flex items-center">
                                <span className="bg-gradient-to-r from-blue-300 to-blue-500 text-transparent bg-clip-text font-semibold tracking-wide">
                                    Running AI Review
                                </span>
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400 ml-3" />
                            </span>
                        )}
                        {phase === 'complete' && 'Review complete'}
                        {phase === 'error' && 'Review failed'}
                    </span>

                    {clusterMapSize > 0 && (
                        <span className="text-gray-500 ml-2 border-l border-gray-700/50 pl-3">
                            {clusterMapSize} cluster{clusterMapSize !== 1 ? 's' : ''}
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
            {hasAnyInput && (
                <button
                    onClick={handleClear}
                    className="px-4 py-2.5 text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 rounded-lg transition-all duration-200 cursor-pointer"
                >
                    Clear
                </button>
            )}
        </div>
    )
}
