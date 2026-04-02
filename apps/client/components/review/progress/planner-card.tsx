import { memo } from 'react'
import { CheckCircle2, Network } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClusterState, StreamPhase } from '@/lib/use-review-stream'
import { AgentIcon, PipelineStepLabel } from './shared'

interface PlannerCardProps {
    clusterMap: Map<string, ClusterState>
    phase: StreamPhase
}

export const PlannerCard = memo(function PlannerCard({ clusterMap, phase }: PlannerCardProps) {
    const planningDone = clusterMap.size > 0
    const planning = !planningDone && phase === 'streaming'

    if (!planning && !planningDone) return null

    const totalFiles = [...clusterMap.values()].reduce((sum, c) => sum + c.files.length, 0)

    return (
        <div>
            <PipelineStepLabel>Planning</PipelineStepLabel>
            <div className={cn(
                'rounded-lg border px-4 py-3 transition-colors',
                planningDone ? 'border-gray-800/70 bg-gray-900/20' : 'border-gray-700/50 bg-gray-900/40',
            )}>
                <div className="flex items-center gap-3 flex-wrap">
                    {planningDone
                        ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        : <AgentIcon className="h-3.5 mx-0.5" />
                    }
                    <Network className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                    <span className="text-sm font-medium text-gray-200">Planner</span>

                    {!planningDone && (
                        <span className="text-xs text-blue-400/80 inline-flex animate-pulse">
                            Structuring review clusters…
                        </span>
                    )}

                    {planningDone && (
                        <span className="text-xs text-gray-600">
                            Distributed {totalFiles} files across {clusterMap.size} clusters
                        </span>
                    )}
                </div>
            </div>
        </div>
    )
})
