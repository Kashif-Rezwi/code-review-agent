'use client'

import { useMemo } from 'react'
import type { ReviewStreamEvent } from '@/types/review.types'
import type { TraceEntry, ClusterState, TaskItem } from '@/lib/use-review-stream'
import { reviewStreamReducer, initialReviewStreamState } from './review-stream.reducer'

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

    let state = initialReviewStreamState
    let thinkingSeq = 0

    for (const event of traceLog) {
        let thinkingSeqId: number | undefined
        if (event.type === 'thinking') {
            thinkingSeqId = ++thinkingSeq
        }
        state = reviewStreamReducer(state, { type: 'EVENT', event, thinkingSeqId })
    }

    const mode: 'code' | 'pr' =
        state.taskItems.length > 0 || state.clusterMap.size > 0 ? 'pr' : 'code'

    return {
        traceEntries: state.traceEntries,
        clusterMap: state.clusterMap,
        taskItems: state.taskItems,
        totalDurationMs: state.totalDurationMs,
        mode,
    }
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
