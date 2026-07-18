import { memo } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClusterState, StreamPhase } from '@/lib/use-review-stream'
import { PipelineStepLabel } from './shared'
import { formatDuration } from '../trace-entries'

interface SynthesizerStepProps {
    phase: StreamPhase
    clusterMap: Map<string, ClusterState>
    totalDurationMs: number | null | undefined
    synthesisStarted: boolean
    outcome: 'complete' | 'partial' | null
}

export const SynthesizerStep = memo(function SynthesizerStep({
    phase,
    clusterMap,
    totalDurationMs,
    synthesisStarted,
    outcome,
}: SynthesizerStepProps) {
    const allWorkersDone = [...clusterMap.values()].every(c => c.done)
    const synthesizing = synthesisStarted && allWorkersDone && phase === 'streaming'
    const complete = synthesisStarted && phase === 'complete'

    if (!synthesizing && !complete) return null

    const totalIssues = [...clusterMap.values()].reduce((sum, c) => sum + (c.issueCount ?? 0), 0)
    const successfulReviews = [...clusterMap.values()].filter(c => !c.failed).length

    return (
        <div className="animate-fade-in">
            <PipelineStepLabel>Synthesis</PipelineStepLabel>
            <div className={cn(
                'rounded-lg border px-4 py-3 transition-colors',
                complete ? 'border-gray-800/70 bg-gray-900/20' : 'border-gray-700/50 bg-gray-900/40',
            )}>
                <div className="flex items-center gap-3">
                    {complete
                        ? outcome === 'partial'
                            ? <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
                            : <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        : <Sparkles className="h-4 w-4 text-blue-400 shrink-0 animate-pulse" />
                    }
                    <span className="text-sm font-medium text-gray-200">Synthesizer</span>
                    <span className="text-xs text-gray-600">
                        {synthesizing && `Merging ${successfulReviews} successful cluster review${successfulReviews !== 1 ? 's' : ''}…`}
                        {complete && `Merged ${successfulReviews} review${successfulReviews !== 1 ? 's' : ''} · ${totalIssues} issue${totalIssues !== 1 ? 's' : ''} total`}
                    </span>
                    {complete && totalDurationMs != null && (
                        <span className="flex items-center gap-1 text-xs text-gray-600 ml-auto">
                            <Clock className="h-3 w-3" />
                            {formatDuration(totalDurationMs)} wall clock
                        </span>
                    )}
                </div>
            </div>
        </div>
    )
})
