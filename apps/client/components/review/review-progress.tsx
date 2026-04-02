'use client'

import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import type { TraceEntry, StreamPhase, ClusterState, TaskItem } from '@/lib/use-review-stream'
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
}

export function ReviewProgress({
    entries,
    taskItems,
    phase,
    clusterMap = new Map(),
    totalDurationMs,
    mode = 'pr'
}: AgentTraceProps) {
    const isStreaming = phase === 'connecting' || phase === 'streaming'

    const allFilesDone = taskItems.length > 0 && taskItems.every(t => t.status === 'done')
    const isClusteredPath = mode === 'pr' && allFilesDone && clusterMap.size > 0
    const hasPlannerStep = clusterMap.size > 0

    const hasRunningTool = entries.some(e => e.kind === 'tool' && e.status === 'running')
    const allToolsDone = entries.some(e => e.kind === 'tool' && e.status === 'done') && !hasRunningTool
    const showSingleAgentSpinner = phase === 'streaming' && !hasPlannerStep && !hasRunningTool && allToolsDone

    const grouped = useMemo(() => groupEntries(entries), [entries])

    const hasContent = taskItems.length > 0 || entries.length > 0 || isStreaming || isClusteredPath
    if (!hasContent) return null

    return (
        <div className="space-y-3">
            {taskItems.length > 0 && (
                <div>
                    <PipelineStepLabel>Data Collection</PipelineStepLabel>
                    <GithubFilesStep items={taskItems} />
                </div>
            )}

            {mode === 'pr' && allFilesDone && (
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
