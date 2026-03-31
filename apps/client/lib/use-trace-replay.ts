'use client'

import { useMemo } from 'react'
import type { ReviewStreamEvent } from '@/types/review.types'
import type { TraceEntry, ClusterState, TaskItem, ClusterFile } from '@/lib/use-review-stream'

export interface TraceReplayResult {
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    taskItems: TaskItem[]
    totalDurationMs: number | null
    /** 'pr' when the trace contains task_plan / cluster_plan events, 'code' otherwise. */
    mode: 'code' | 'pr'
}

/**
 * Pure function to parse a stored trace log into UI state.
 */
export function parseTraceLog(traceLog: ReviewStreamEvent[] | null): TraceReplayResult {
    const empty: TraceReplayResult = {
        traceEntries: [],
        clusterMap: new Map(),
        taskItems: [],
        totalDurationMs: null,
        mode: 'code',
    }

    if (!traceLog || traceLog.length === 0) return empty

    const traceEntries: TraceEntry[] = []
    const clusterMap = new Map<string, ClusterState>()
    const taskItems: TaskItem[] = []
    let totalDurationMs: number | null = null
    let thinkingSeq = 0

    for (const event of traceLog) {
        switch (event.type) {
            case 'task_plan':
                for (const t of event.tasks) {
                    taskItems.push({ ...t, status: 'pending' })
                }
                break

            case 'task_update': {
                const idx = taskItems.findIndex(t => t.id === event.taskId)
                if (idx !== -1) {
                    taskItems[idx] = {
                        ...taskItems[idx],
                        status: event.status,
                        detail: event.detail ?? taskItems[idx].detail,
                    }
                }
                break
            }

            case 'cluster_plan':
                for (const c of event.clusters) {
                    clusterMap.set(c.id, {
                        id: c.id,
                        label: c.label,
                        focus: c.focus,
                        files: (c.files ?? []) as ClusterFile[],
                        traceEntries: [],
                        done: false,
                    })
                }
                break

            case 'cluster_done': {
                const c = clusterMap.get(event.clusterId)
                if (c) {
                    clusterMap.set(event.clusterId, {
                        ...c,
                        issueCount: event.issueCount,
                        durationMs: event.durationMs,
                        done: true,
                    })
                }
                break
            }

            case 'thinking': {
                const entry: TraceEntry = {
                    kind: 'thinking',
                    id: `thinking-${++thinkingSeq}`,
                    text: event.text,
                }
                if (event.clusterId) {
                    const c = clusterMap.get(event.clusterId)
                    if (c) clusterMap.set(event.clusterId, { ...c, traceEntries: [...c.traceEntries, entry] })
                } else {
                    traceEntries.push(entry)
                }
                break
            }

            case 'tool_start': {
                const entry: TraceEntry = {
                    kind: 'tool',
                    id: event.callId,
                    tool: event.tool,
                    label: event.label,
                    status: 'running',
                    detail: event.detail,
                }
                if (event.clusterId) {
                    const c = clusterMap.get(event.clusterId)
                    if (c) clusterMap.set(event.clusterId, { ...c, traceEntries: [...c.traceEntries, entry] })
                } else {
                    traceEntries.push(entry)
                }
                break
            }

            case 'tool_done': {
                const patch = (entries: TraceEntry[]): TraceEntry[] =>
                    entries.map(e =>
                        e.kind === 'tool' && e.id === event.callId
                            ? { ...e, label: event.label || e.label, status: 'done' as const, detail: event.detail ?? e.detail, durationMs: event.durationMs }
                            : e,
                    )
                if (event.clusterId) {
                    const c = clusterMap.get(event.clusterId)
                    if (c) clusterMap.set(event.clusterId, { ...c, traceEntries: patch(c.traceEntries) })
                } else {
                    // Mutate in place — array is local to this memo, never shared
                    const idx = traceEntries.findIndex(e => e.kind === 'tool' && e.id === event.callId)
                    if (idx !== -1) {
                        const e = traceEntries[idx] as Extract<TraceEntry, { kind: 'tool' }>
                        traceEntries[idx] = {
                            ...e,
                            label: event.label || e.label,
                            status: 'done',
                            detail: event.detail ?? e.detail,
                            durationMs: event.durationMs,
                        }
                    }
                }
                break
            }

            case 'complete':
                totalDurationMs = event.durationMs
                // Mark every cluster as done — some may lack a cluster_done event
                // if the review used the single-cluster shortcut path.
                for (const [id, c] of clusterMap) {
                    if (!c.done) clusterMap.set(id, { ...c, done: true })
                }
                break
        }
    }

    const mode: 'code' | 'pr' =
        taskItems.length > 0 || clusterMap.size > 0 ? 'pr' : 'code'

    return { traceEntries, clusterMap, taskItems, totalDurationMs, mode }
}

/**
 * Replays a stored `ReviewStreamEvent[]` trace into the same data structures
 * that `useReviewStream` builds during live streaming.
 *
 * This is a pure synchronous computation wrapped in `useMemo` — it runs once
 * on mount and is never re-computed (the trace never changes after load).
 * The result can be fed directly into `<ReviewProgress phase="complete" …/>`.
 */
export function useTraceReplay(traceLog: ReviewStreamEvent[] | null): TraceReplayResult {
    return useMemo(() => parseTraceLog(traceLog), [traceLog])
}
