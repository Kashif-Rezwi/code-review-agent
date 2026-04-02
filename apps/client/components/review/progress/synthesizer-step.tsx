import { memo } from 'react'
import { CheckCircle2, Clock, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClusterState, StreamPhase } from '@/lib/use-review-stream'
import { PipelineStepLabel } from './shared'
import { formatDuration } from '../trace-entries'

interface SynthesizerStepProps {
    phase: StreamPhase
    clusterMap: Map<string, ClusterState>
    totalDurationMs: number | null | undefined
}

export const SynthesizerStep = memo(function SynthesizerStep({
    phase,
    clusterMap,
    totalDurationMs,
}: SynthesizerStepProps) {
    const allWorkersDone = [...clusterMap.values()].every(c => c.done)
    const synthesizing = allWorkersDone && phase === 'streaming'
    const complete = phase === 'complete'

    if (!synthesizing && !complete) return null

    const totalIssues = [...clusterMap.values()].reduce((sum, c) => sum + (c.issueCount ?? 0), 0)

    return (
        <div className="animate-fade-in">
            <PipelineStepLabel>Synthesis</PipelineStepLabel>
            <div className={cn(
                'rounded-lg border px-4 py-3 transition-colors',
                complete ? 'border-gray-800/70 bg-gray-900/20' : 'border-gray-700/50 bg-gray-900/40',
            )}>
                <div className="flex items-center gap-3">
                    {complete
                        ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        : <Sparkles className="h-4 w-4 text-blue-400 shrink-0 animate-pulse" />
                    }
                    <span className="text-sm font-medium text-gray-200">Synthesizer</span>
                    <span className="text-xs text-gray-600">
                        {synthesizing && `Merging ${clusterMap.size} cluster reviews…`}
                        {complete && `Merged ${clusterMap.size} reviews · ${totalIssues} issue${totalIssues !== 1 ? 's' : ''} total`}
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
