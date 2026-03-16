'use client'

import { memo, useMemo, useState } from 'react'
import {
    CheckCircle2,
    Clock,
    Loader2,
    Network,
    Sparkles,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TraceEntry, StreamPhase, ClusterState, TaskItem } from '@/lib/use-review-stream'
import { groupEntries } from '@/lib/group-entries'
import { GithubFilesStep } from './github-files-step'
import {
    ThinkingGroup,
    ToolStep,
    LinterGroup,
    formatDuration,
} from './trace-entries'

// ── AgentIcon ─────────────────────────────────────────────────────────────────
// Reusable spinner for any in-progress agent step.

const AgentIcon = ({ className = '' }: { className?: string }) => (
    <Loader2 className={cn('shrink-0 animate-spin text-blue-400', className)} />
)

// ── PipelineStepLabel ─────────────────────────────────────────────────────────
// Small uppercase section divider for each pipeline stage.

function PipelineStepLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700 mb-1.5 px-0.5">
            {children}
        </p>
    )
}

// ── PlannerCard ───────────────────────────────────────────────────────────────

interface PlannerCardProps {
    clusterMap: Map<string, ClusterState>
    phase: StreamPhase
}

const PlannerCard = memo(function PlannerCard({ clusterMap, phase }: PlannerCardProps) {
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

// ── WorkerCard ────────────────────────────────────────────────────────────────
// Compact grid cell for one parallel worker agent.

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
            {/* Status row */}
            <div className="flex items-center gap-2 mb-2.5">
                {cluster.done
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    : <AgentIcon className="h-2.5 ml-0.5 mr-0.5" />
                }
                <span className="text-xs font-medium text-gray-200 truncate leading-none">
                    {cluster.label}
                </span>
            </div>

            {/* Meta row */}
            <div className="flex items-center gap-1.5 flex-wrap">
                {!cluster.done && (
                    <span className="text-[11px] text-blue-400/70">Analyzing…</span>
                )}
                {cluster.done && cluster.issueCount !== undefined && (
                    <span className={cn(
                        'text-[11px] px-1.5 py-0.5 rounded-full font-medium border',
                        cluster.issueCount > 0
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-green-500/10 text-green-500 border-green-500/20',
                    )}>
                        {cluster.issueCount === 0 ? 'Clean' : `${cluster.issueCount} issue${cluster.issueCount !== 1 ? 's' : ''}`}
                    </span>
                )}
                {cluster.durationMs != null && (
                    <span className="text-[11px] text-gray-600 tabular-nums">
                        {formatDuration(cluster.durationMs)}
                    </span>
                )}
                {toolCount > 0 && (
                    <span className="text-[11px] text-gray-700 ml-auto tabular-nums">
                        {toolCount} call{toolCount !== 1 ? 's' : ''}
                    </span>
                )}
            </div>
        </button>
    )
})

// ── WorkersGrid ───────────────────────────────────────────────────────────────
// Shows all parallel worker agents side-by-side to convey simultaneous execution.
// Clicking a worker shows its trace details in a panel below the grid.

function WorkersGrid({ clusterMap }: { clusterMap: Map<string, ClusterState> }) {
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const selected = selectedId ? (clusterMap.get(selectedId) ?? null) : null

    const renderGroups = useMemo(
        () => selected ? groupEntries(selected.traceEntries) : [],
        [selected],
    )

    const total = clusterMap.size
    const running = [...clusterMap.values()].filter(c => !c.done).length
    const done = total - running

    const cols = total <= 2 ? total : total === 3 ? 3 : 4

    return (
        <div>
            <PipelineStepLabel>
                Parallel Analysis
                {running > 0
                    ? ` · ${running} agent${running !== 1 ? 's' : ''} running`
                    : ` · ${done} completed`
                }
            </PipelineStepLabel>

            {/* Worker grid — side-by-side to convey simultaneity */}
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

            {/* Detail panel for selected worker */}
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

// ── SynthesizerStep ───────────────────────────────────────────────────────────
// Final LLM call that merges all partial cluster reviews.

const SynthesizerStep = memo(function SynthesizerStep({
    phase,
    clusterMap,
    totalDurationMs,
}: {
    phase: StreamPhase
    clusterMap: Map<string, ClusterState>
    totalDurationMs: number | null | undefined
}) {
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface AgentTraceProps {
    entries: TraceEntry[]
    taskItems: TaskItem[]
    phase: StreamPhase
    clusterMap?: Map<string, ClusterState>
    totalDurationMs?: number | null
    mode?: 'code' | 'pr'
}

// ── ReviewProgress ────────────────────────────────────────────────────────────

export function ReviewProgress({ entries, taskItems, phase, clusterMap = new Map(), totalDurationMs, mode = 'pr' }: AgentTraceProps) {
    const isStreaming = phase === 'connecting' || phase === 'streaming'

    // Stage gate: every stage after Data Collection only renders once all files
    // are confirmed received. This is purely data-driven — no timeouts or effects.
    // On the code path taskItems is always empty so allFilesDone stays false and
    // these stages never render (correct, they're PR-only).
    const allFilesDone = taskItems.length > 0 && taskItems.every(t => t.status === 'done')

    const isClusteredPath = mode === 'pr' && allFilesDone && clusterMap.size > 0
    // Hide the single-agent trace only when cluster workers are active.
    // On the fallback path (no clusters) the trace must still render.
    const hasPlannerStep = clusterMap.size > 0

    // Single-agent path spinner logic
    const hasRunningTool = entries.some(e => e.kind === 'tool' && e.status === 'running')
    const allToolsDone = entries.some(e => e.kind === 'tool' && e.status === 'done') && !hasRunningTool
    const showSingleAgentSpinner = phase === 'streaming' && !hasPlannerStep && !hasRunningTool && allToolsDone

    const grouped = useMemo(() => groupEntries(entries), [entries])

    const hasContent = taskItems.length > 0 || entries.length > 0 || isStreaming || isClusteredPath
    if (!hasContent) return null

    return (
        <div className="space-y-3">
            {/* ── Connecting placeholder ──────────────────────── */}
            {phase === 'connecting' && taskItems.length === 0 && entries.length === 0 && mode === 'pr' && (
                <div className="flex items-center gap-2.5 py-1 animate-fade-in pl-1 text-gray-500">
                    <AgentIcon className="h-2.5 opacity-60 ml-0.5" />
                    <span className="text-sm font-medium inline-flex">Connecting to agent environment</span>
                </div>
            )}

            {/* ── Stage 1: Data Collection — file list with diff stats ──────── */}
            {taskItems.length > 0 && (
                <div>
                    <PipelineStepLabel>Data Collection</PipelineStepLabel>
                    <GithubFilesStep items={taskItems} />
                </div>
            )}

            {/* ── Stage 2: Planning — only after all files are confirmed done ── */}
            {mode === 'pr' && allFilesDone && (
                <PlannerCard clusterMap={clusterMap} phase={phase} />
            )}

            {/* ── Stage 3: Parallel workers ────────────────────────────────── */}
            {isClusteredPath && (
                <WorkersGrid clusterMap={clusterMap} />
            )}

            {/* ── Stage 4: Synthesis ───────────────────────────────────────── */}
            {isClusteredPath && (
                <SynthesizerStep
                    phase={phase}
                    clusterMap={clusterMap}
                    totalDurationMs={totalDurationMs}
                />
            )}

            {/* ── Single-agent trace timeline (code review + PR fallback) ───── */}
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
