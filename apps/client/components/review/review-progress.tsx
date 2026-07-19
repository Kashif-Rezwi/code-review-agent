'use client'

import { useMemo } from 'react'
import { AlertTriangle, CloudDownload, Sparkles } from 'lucide-react'
import type { AcquisitionState, TraceEntry, StreamPhase, ClusterState, TaskItem } from '@/lib/use-review-stream'
import { groupEntries } from '@/lib/group-entries'
import { GithubFilesStep } from './github-files-step'
import {
    ThinkingGroup,
    ToolStep,
    LinterGroup,
} from './trace-entries'
import { PipelineStepLabel, AgentIcon } from './progress/shared'
import { PlannerCard } from './progress/planner-card'
import { WorkersGrid } from './progress/workers-grid'
import { SynthesizerStep } from './progress/synthesizer-step'

interface AgentTraceProps {
    entries: TraceEntry[]
    taskItems: TaskItem[]
    phase: StreamPhase
    clusterMap?: Map<string, ClusterState>
    totalDurationMs?: number | null
    mode?: 'code' | 'pr'
    acquisition?: AcquisitionState | null
    outcome?: 'complete' | 'partial' | null
    synthesisStarted?: boolean
}

export function ReviewProgress({
    entries,
    taskItems,
    phase,
    clusterMap = new Map(),
    totalDurationMs,
    mode = 'pr',
    acquisition = null,
    outcome = null,
    synthesisStarted = false,
}: AgentTraceProps) {
    const isStreaming = phase === 'connecting' || phase === 'streaming'

    const isClusteredPath = mode === 'pr' && clusterMap.size > 0
    const hasPlannerStep = clusterMap.size > 0

    const hasRunningTool = entries.some(e => e.kind === 'tool' && e.status === 'running')
    const allToolsDone = entries.some(e => e.kind === 'tool' && e.status === 'done') && !hasRunningTool
    const showSingleAgentSpinner = phase === 'streaming' && !hasPlannerStep && !hasRunningTool && allToolsDone

    const grouped = useMemo(() => groupEntries(entries), [entries])

    const hasContent = taskItems.length > 0 || entries.length > 0 || isStreaming || isClusteredPath || !!acquisition
    if (!hasContent) return null

    return (
        <div className="space-y-3">
            {acquisition && (
                <div className={`rounded-lg border px-4 py-3 ${acquisition.warnings.length > 0 ? 'border-amber-500/25 bg-amber-950/10' : 'border-gray-800/70 bg-gray-900/20'}`}>
                    <div className="flex items-center gap-2.5">
                        <CloudDownload className="h-4 w-4 text-blue-400" />
                        <span className="text-sm font-medium text-gray-200">
                            Loaded {acquisition.fileCount} files
                        </span>
                        <span className="text-xs text-gray-600">
                            via {acquisition.source === 'public_diff' ? 'public diff fallback' : 'GitHub files API'}
                        </span>
                    </div>
                    {acquisition.warnings.length > 0 && (
                        <div className="mt-2 flex items-start gap-2 text-xs text-amber-300/80">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span>{acquisition.warnings.join(' ')}</span>
                        </div>
                    )}
                </div>
            )}
            {taskItems.length > 0 && (
                <div>
                    <PipelineStepLabel>Data Collection</PipelineStepLabel>
                    <GithubFilesStep items={taskItems} />
                </div>
            )}

            {mode === 'pr' && clusterMap.size > 0 && (
                <PlannerCard clusterMap={clusterMap} phase={phase} />
            )}

            {isClusteredPath && (
                <WorkersGrid clusterMap={clusterMap} />
            )}

            {isClusteredPath && (
                <SynthesizerStep
                    phase={phase}
                    clusterMap={clusterMap}
                    totalDurationMs={totalDurationMs}
                    synthesisStarted={synthesisStarted}
                    outcome={outcome}
                />
            )}

            {!hasPlannerStep && (
                <div className="space-y-1">
                    {grouped.map(group => {
                        if (group.kind === 'thinking-group')
                            return <ThinkingGroup key={group.id} entries={group.entries} />
                        if (group.kind === 'linter-group')
                            return <LinterGroup key={group.id} entries={group.entries} />
                        return <ToolStep key={group.entry.id} entry={group.entry} />
                    })}
                    {showSingleAgentSpinner && (
                        <div className="flex items-center gap-2.5 py-2 px-4 rounded-lg border border-gray-800/60 bg-gray-900/20 animate-fade-in">
                            <Sparkles className="h-3.5 w-3.5 text-blue-400 shrink-0 animate-pulse" />
                            <span className="text-sm bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent font-medium tracking-wide flex items-center gap-3">
                                Generating final review
                                <AgentIcon className="h-3" />
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
