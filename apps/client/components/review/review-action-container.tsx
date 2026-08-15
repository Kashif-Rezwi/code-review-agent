import Link from 'next/link'
import { BrainCircuit, Clock, Loader2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReviewActionContainerProps {
    phase: string
    isStreaming: boolean
    clusterMapSize: number
    totalDurationMs: number | null
    outcome?: 'complete' | 'partial' | null
    canSubmit: boolean
    hasAnyInput: boolean
    creditCost?: number
    balance?: number
    hasSufficientCredits?: boolean
    handleReview: () => void
    handleClear: () => void
}

export function ReviewActionContainer({
    phase,
    isStreaming,
    clusterMapSize,
    totalDurationMs,
    outcome,
    canSubmit,
    hasAnyInput,
    creditCost = 5,
    balance = 0,
    hasSufficientCredits = true,
    handleReview,
    handleClear,
}: ReviewActionContainerProps) {
    return (
        <div className="flex items-center gap-4">
            {!isStreaming && phase !== 'complete' && phase !== 'error' ? (
                !hasSufficientCredits && hasAnyInput ? (
                    <Link
                        href="/account"
                        className="group flex items-center gap-2.5 px-4 py-2.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-sm cursor-pointer transition-all duration-200 text-amber-300 font-medium shadow-[0_0_15px_rgba(245,158,11,0.1)]"
                    >
                        <Zap className="h-4 w-4 shrink-0 text-amber-400" />
                        <span>Insufficient Credits ({balance}/{creditCost}) — Top Up</span>
                    </Link>
                ) : (
                    <button
                        onClick={handleReview}
                        disabled={!canSubmit}
                        className="group flex items-center gap-2.5 px-5 py-2.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-400/40 text-sm cursor-pointer transition-all duration-200 shadow-[0_0_15px_rgba(59,130,246,0.1)] hover:shadow-[0_0_25px_rgba(59,130,246,0.2)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-500/10 disabled:hover:border-blue-500/20 disabled:hover:shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                    >
                        <BrainCircuit className="h-4 w-4 shrink-0 text-blue-400 transition-colors" />
                        <span className="font-medium text-blue-100 transition-colors">
                            Run Review <span className="text-xs text-blue-400/80 ml-1">({creditCost} credits)</span>
                        </span>
                    </button>
                )
            ) : (

                <div className="flex items-center gap-2.5 px-5 py-2.5 border border-blue-500/20 bg-blue-500/5 rounded-lg text-sm shadow-[0_0_15px_rgba(59,130,246,0.05)] transition-all duration-200">
                    <BrainCircuit
                        className={cn(
                            'h-4 w-4 shrink-0 transition-colors',
                            isStreaming
                                ? 'text-blue-400/80 animate-pulse'
                                : phase === 'error'
                                ? 'text-red-500'
                                : outcome === 'partial'
                                ? 'text-amber-400'
                                : 'text-green-500'
                        )}
                    />
                    <span
                        className={`font-medium ${
                            phase === 'complete' || phase === 'error' ? 'text-gray-400' : 'text-blue-200'
                        }`}
                    >
                        {phase === 'connecting' && (
                            <span className="inline-flex items-center">
                                <span className="bg-gradient-to-r from-blue-300 to-blue-500 text-transparent bg-clip-text font-semibold tracking-wide">
                                    Connecting
                                </span>
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400 ml-3" />
                            </span>
                        )}
                        {phase === 'streaming' && (
                            <span className="inline-flex items-center">
                                <span className="bg-gradient-to-r from-blue-300 to-blue-500 text-transparent bg-clip-text font-semibold tracking-wide">
                                    Running AI Review
                                </span>
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400 ml-3" />
                            </span>
                        )}
                        {phase === 'complete' && (outcome === 'partial' ? 'Review partial' : 'Review complete')}
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
                    className={cn(
                        'px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 cursor-pointer',
                        isStreaming
                            ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60'
                    )}
                >
                    {isStreaming ? 'Cancel' : 'Clear'}
                </button>
            )}
        </div>
    )
}
