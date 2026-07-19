import { memo, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClusterState } from '@/lib/use-review-stream'
import { groupEntries } from '@/lib/group-entries'
import { Badge } from '@/components/ui/badge'
import { AgentIcon, PipelineStepLabel } from './shared'
import {
    ThinkingGroup,
    ToolStep,
    LinterGroup,
    formatDuration,
} from '../trace-entries'

const WorkerCard = memo(function WorkerCard({
    cluster,
    isSelected,
    onClick,
}: {
    cluster: ClusterState
    isSelected: boolean
    onClick: () => void
}) {
    const toolCount = cluster.traceEntries.filter(e => e.kind === 'tool').length

    return (
        <button
            onClick={onClick}
            className={cn(
                'rounded-lg border p-3 text-left transition-all w-full',
                isSelected
                    ? 'border-blue-500/40 bg-blue-950/20 ring-1 ring-blue-500/20'
                    : cluster.done
                        ? 'border-gray-800/70 bg-gray-900/20 hover:border-gray-700/50 hover:bg-gray-900/40'
                        : 'border-gray-700/50 bg-gray-900/40',
            )}
        >
            <div className="flex items-center gap-2 mb-2.5">
                {cluster.done
                    ? cluster.failed
                        ? <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                        : <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    : <AgentIcon className="h-2.5 ml-0.5 mr-0.5" />
                }
                <span className="text-xs font-medium text-gray-200 truncate leading-none">
                    {cluster.label}
                </span>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
                {!cluster.done && (
                    <span className="text-xs text-blue-400/70">Analyzing…</span>
                )}
                {cluster.failed && (
                    <Badge variant="amber" className="font-medium">Failed after retry</Badge>
                )}
                {cluster.done && !cluster.failed && cluster.issueCount !== undefined && (
                    <Badge variant={cluster.issueCount > 0 ? 'amber' : 'green'} className="font-medium">
                        {cluster.issueCount === 0 ? 'Clean' : `${cluster.issueCount} issue${cluster.issueCount !== 1 ? 's' : ''}`}
                    </Badge>
                )}
                {cluster.done && !cluster.failed && (cluster.attempts ?? 1) > 1 && (
                    <Badge variant="amber" className="font-medium">Succeeded on retry</Badge>
                )}
                {cluster.durationMs != null && (
                    <span className="text-xs text-gray-600 tabular-nums">
                        {formatDuration(cluster.durationMs)}
                    </span>
                )}
                {toolCount > 0 && (
                    <span className="text-xs text-gray-700 ml-auto tabular-nums">
                        {toolCount} call{toolCount !== 1 ? 's' : ''}
                    </span>
                )}
            </div>
        </button>
    )
})

export function WorkersGrid({ clusterMap }: { clusterMap: Map<string, ClusterState> }) {
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const selected = selectedId ? (clusterMap.get(selectedId) ?? null) : null

    const renderGroups = useMemo(
        () => selected ? groupEntries(selected.traceEntries) : [],
        [selected],
    )

    const total = clusterMap.size
    const running = [...clusterMap.values()].filter(c => !c.done).length
    const done = total - running
    const failed = [...clusterMap.values()].filter(c => c.failed).length

    const cols = total <= 2 ? total : total === 3 ? 3 : 4

    return (
        <div>
            <PipelineStepLabel>
                Parallel Analysis
                {running > 0
                    ? ` · ${running} agent${running !== 1 ? 's' : ''} running`
                    : ` · ${done} settled${failed > 0 ? ` · ${failed} failed` : ''}`
                }
            </PipelineStepLabel>

            <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
                {[...clusterMap.values()].map(cluster => (
                    <WorkerCard
                        key={cluster.id}
                        cluster={cluster}
                        isSelected={selectedId === cluster.id}
                        onClick={() => setSelectedId(id => id === cluster.id ? null : cluster.id)}
                    />
                ))}
            </div>

            {selected && (
                <div className="mt-2 rounded-lg border border-blue-500/20 bg-gray-900/30 px-4 py-3 animate-fade-in">
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-medium text-gray-400">
                            {selected.label}
                            <span className="text-gray-700 font-normal ml-1.5">— event logs</span>
                        </span>
                        <button
                            onClick={() => setSelectedId(null)}
                            className="text-gray-700 hover:text-gray-400 transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>

                    {selected.traceEntries.length === 0 && (
                        <div className="flex items-center gap-2.5 text-xs text-gray-500 py-1 font-medium">
                            <AgentIcon className="h-2.5 opacity-60 ml-0.5" />
                            Provisioning agent instance
                        </div>
                    )}

                    <div className="space-y-1">
                        {renderGroups.map(group => {
                            if (group.kind === 'thinking-group')
                                return <ThinkingGroup key={group.id} entries={group.entries} />
                            if (group.kind === 'linter-group')
                                return <LinterGroup key={group.id} entries={group.entries} />
                            return <ToolStep key={group.entry.id} entry={group.entry} />
                        })}
                    </div>
                </div>
            )}
        </div>
    )
}
