'use client'

import { useMemo, useState } from 'react'
import {
    CheckCircle2,
    Clock,
    Loader2,
    Network,
    Sparkles,
    X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskItem, TraceEntry, StreamPhase, ClusterState } from '@/lib/use-review-stream'
import { GithubFilesStep } from './github-files-step'
import {
    ThinkingGroup,
    ToolStep,
    LinterGroup,
    formatDuration,
    type ThinkingEntry,
} from './trace-entries'

// ── Entry grouping ────────────────────────────────────────────────────────────

type ToolEntry = Extract<TraceEntry, { kind: 'tool' }>

type RenderGroup =
    | { kind: 'thinking-group'; id: string; entries: ThinkingEntry[] }
    | { kind: 'tool'; entry: ToolEntry }
    | { kind: 'linter-group'; id: string; entries: ToolEntry[] }

function groupEntries(entries: TraceEntry[]): RenderGroup[] {
    const groups: RenderGroup[] = []
    for (const entry of entries) {
        if (entry.kind === 'thinking') {
            const last = groups.at(-1)
            if (last?.kind === 'thinking-group') {
                last.entries.push(entry as ThinkingEntry)
            } else {
                groups.push({ kind: 'thinking-group', id: `tg-${entry.id}`, entries: [entry as ThinkingEntry] })
            }
        } else if (entry.kind === 'tool') {
            const toolEntry = entry as ToolEntry
            if (toolEntry.tool === 'runLinter') {
                const last = groups.at(-1)
                if (last?.kind === 'linter-group') {
                    last.entries.push(toolEntry)
                } else {
                    groups.push({ kind: 'linter-group', id: `lg-${entry.id}`, entries: [toolEntry] })
                }
            } else {
                groups.push({ kind: 'tool', entry: toolEntry })
            }
        }
    }
    return groups
}

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
    taskItems: TaskItem[]
    clusterMap: Map<string, ClusterState>
    phase: StreamPhase
}

function PlannerCard({ taskItems, clusterMap, phase }: PlannerCardProps) {
    const planningDone = clusterMap.size > 0
    const planning = taskItems.length > 0 && !planningDone && phase === 'streaming'

    if (!planning && !planningDone) return null

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
                        : <Loader2 className="h-4 w-4 animate-spin text-blue-400 shrink-0" />
                    }
                    <Network className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                    <span className="text-sm font-medium text-gray-200">Planner</span>

                    {!planningDone && (
                        <span className="text-xs text-blue-400/80">
                            Grouping {taskItems.length} files into review clusters…
                        </span>
                    )}

                    {planningDone && (
                        <span className="text-xs text-gray-600">
                            Distributed {taskItems.length} files across {clusterMap.size} clusters
                        </span>
                    )}
                </div>
            </div>
        </div>
    )
}

// ── WorkerCard ────────────────────────────────────────────────────────────────
// Compact grid cell for one parallel worker agent.

function WorkerCard({
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
                    : <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
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
}

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
                            <span className="text-gray-700 font-normal ml-1.5">— agent trace</span>
                        </span>
                        <button
                            onClick={() => setSelectedId(null)}
                            className="text-gray-700 hover:text-gray-400 transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>

                    {selected.traceEntries.length === 0 && (
                        <div className="flex items-center gap-2 text-xs text-gray-600 py-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Waiting for agent to start…
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

function SynthesizerStep({
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
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface AgentTraceProps {
    entries: TraceEntry[]
    taskItems: TaskItem[]
    phase: StreamPhase
    clusterMap?: Map<string, ClusterState>
    totalDurationMs?: number | null
}

// ── ReviewProgress ────────────────────────────────────────────────────────────

export function ReviewProgress({ entries, taskItems, phase, clusterMap, totalDurationMs }: AgentTraceProps) {
    const isStreaming = phase === 'connecting' || phase === 'streaming'

    const isClusteredPath = clusterMap && clusterMap.size > 0
    const hasPlannerStep = clusterMap !== undefined && taskItems.length > 0

    // Single-agent path spinner logic
    const hasRunningTool = entries.some(e => e.kind === 'tool' && e.status === 'running')
    const allToolsDone = entries.some(e => e.kind === 'tool' && e.status === 'done') && !hasRunningTool
    const showSingleAgentSpinner = phase === 'streaming' && !hasPlannerStep
        && !hasRunningTool && (allToolsDone || taskItems.length > 0)

    const grouped = useMemo(() => groupEntries(entries), [entries])

    const hasContent = taskItems.length > 0 || entries.length > 0 || isStreaming || isClusteredPath
    if (!hasContent) return null

    return (
        <div className="space-y-3">
            {/* ── Connecting placeholder ──────────────────────── */}
            {phase === 'connecting' && taskItems.length === 0 && entries.length === 0 && (
                <div className="flex items-center gap-2.5 py-1 animate-fade-in">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-700 shrink-0" />
                    <span className="text-sm text-gray-600">Starting up…</span>
                </div>
            )}

            {/* ── Stage 1: Data collection ────────────────────── */}
            {taskItems.length > 0 && (
                <div>
                    <PipelineStepLabel>Data Collection</PipelineStepLabel>
                    <GithubFilesStep items={taskItems} />
                </div>
            )}

            {/* ── Stage 2: Planning (multi-agent path only) ────── */}
            {clusterMap !== undefined && (
                <PlannerCard taskItems={taskItems} clusterMap={clusterMap} phase={phase} />
            )}

            {/* ── Stage 3: Parallel workers ───────────────────── */}
            {isClusteredPath && (
                <WorkersGrid clusterMap={clusterMap} />
            )}

            {/* ── Stage 4: Synthesis ─────────────────────────── */}
            {isClusteredPath && (
                <SynthesizerStep
                    phase={phase}
                    clusterMap={clusterMap}
                    totalDurationMs={totalDurationMs}
                />
            )}

            {/* ── Single-agent trace timeline ─────────────────── */}
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
                            <span className="text-sm text-gray-300">Generating review…</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
