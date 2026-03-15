'use client'

import { useMemo, useState } from 'react'
import { BrainCircuit, ChevronDown, ChevronRight, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskItem, TraceEntry, StreamPhase } from '@/lib/use-review-stream'
import { GithubFilesStep } from './github-files-step'
import {
    ThinkingGroup,
    ToolStep,
    formatDuration,
    type ThinkingEntry,
} from './trace-entries'

// ── Entry grouping ────────────────────────────────────────────────────────────

type RenderGroup =
    | { kind: 'thinking-group'; id: string; entries: ThinkingEntry[] }
    | { kind: 'tool'; entry: Extract<TraceEntry, { kind: 'tool' }> }

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
            groups.push({ kind: 'tool', entry: entry as Extract<TraceEntry, { kind: 'tool' }> })
        }
    }
    return groups
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface AgentTraceProps {
    entries: TraceEntry[]
    taskItems: TaskItem[]
    phase: StreamPhase
    totalDurationMs?: number | null
    stepCount?: number | null
}

// ── Container ─────────────────────────────────────────────────────────────────

export function ReviewProgress({ entries, taskItems, phase, totalDurationMs, stepCount }: AgentTraceProps) {
    const isComplete = phase === 'complete'
    const isStreaming = phase === 'connecting' || phase === 'streaming'

    // Show "Generating review…" spinner when no tool is running but we have
    // completed work (tools done or task board populated) and are still streaming.
    // Thinking events no longer suppress this — the spinner and thinking coexist.
    const hasRunningTool = entries.some(e => e.kind === 'tool' && e.status === 'running')
    const allToolsDone = entries.some(e => e.kind === 'tool' && e.status === 'done') && !hasRunningTool
    const showGenerating = phase === 'streaming' && !hasRunningTool
        && (allToolsDone || taskItems.length > 0)

    const [globalOpen, setGlobalOpen] = useState(true)
    const grouped = useMemo(() => groupEntries(entries), [entries])

    // Use the authoritative stepCount from the complete event when available;
    // fall back to computed count while streaming.
    const displaySteps = stepCount ?? ((taskItems.length > 0 ? 1 : 0) + grouped.length)

    const hasContent = taskItems.length > 0 || entries.length > 0 || isStreaming
    if (!hasContent) return null

    return (
        <div>
            {/* ── Global header ─────────────────────────────────────── */}
            <button
                onClick={() => setGlobalOpen(p => !p)}
                className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition-colors mb-3"
            >
                {globalOpen
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                }
                <BrainCircuit className={cn(
                    'h-4 w-4 shrink-0',
                    isComplete ? 'text-green-500' : 'text-blue-400',
                )} />
                <span className={cn('font-medium', isComplete ? 'text-gray-400' : 'text-gray-300')}>
                    {phase === 'connecting' && 'Connecting to agent…'}
                    {phase === 'streaming' && 'Agent is analysing…'}
                    {phase === 'complete' && 'Agent trace'}
                    {phase === 'error' && 'Agent trace (error)'}
                </span>
                {isStreaming && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                )}
                {displaySteps > 0 && (
                    <span className="text-gray-600">{displaySteps} step{displaySteps !== 1 ? 's' : ''}</span>
                )}
                {isComplete && totalDurationMs != null && (
                    <span className="flex items-center gap-1 text-gray-600">
                        <Clock className="h-3 w-3" />
                        {formatDuration(totalDurationMs)}
                    </span>
                )}
            </button>

            {globalOpen && (
                <div className="ml-1 pl-4 border-l border-gray-800 space-y-2">

                    {/* ── Connecting placeholder ─────────────────── */}
                    {phase === 'connecting' && taskItems.length === 0 && entries.length === 0 && (
                        <div className="flex items-center gap-2.5 py-1 animate-fade-in">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-700 shrink-0" />
                            <span className="text-sm text-gray-600">Starting up…</span>
                        </div>
                    )}

                    {/* ── GITHUB step: file task list ────────────────────────────────
                        Styled exactly like a ToolStep with GITHUB badge.
                        Shows "Found N changed files" once done, with filenames as detail.
                        Expands to show each file's status inline. */}
                    {taskItems.length > 0 && (
                        <GithubFilesStep items={taskItems} />
                    )}

                    {/* ── Trace timeline ─────────────────────────────────── */}
                    {grouped.map(group => {
                        if (group.kind === 'thinking-group')
                            return <ThinkingGroup key={group.id} entries={group.entries} />
                        return <ToolStep key={group.entry.id} entry={group.entry} />
                    })}

                    {/* ── "Generating review…" spinner ──────────────────── */}
                    {showGenerating && (
                        <div className="flex items-center gap-2.5 py-1 animate-fade-in">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
                            <span className="text-sm text-gray-300">Generating review…</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
