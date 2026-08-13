'use client'

import { useMemo } from 'react'
import type { ReviewStreamEvent } from '@/types/review.types'
import type { AcquisitionState, TraceEntry, ClusterState, TaskItem } from '@/lib/use-review-stream'
import { reviewStreamReducer, initialReviewStreamState } from './review-stream.reducer'

export interface TraceReplayResult {
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    taskItems: TaskItem[]
    totalDurationMs: number | null
    /** 'pr' when the trace contains task_plan / cluster_plan events, 'code' otherwise. */
    mode: 'code' | 'pr'
    acquisition: AcquisitionState | null
    outcome: 'complete' | 'partial' | null
    synthesisStarted: boolean
}


/** Pure function to parse a stored trace log into UI state. */
export function parseTraceLog(
    traceLog: ReviewStreamEvent[] | null,
    reviewType?: 'CODE' | 'PR',
): TraceReplayResult {
    const empty: TraceReplayResult = {
        traceEntries: [],
        clusterMap: new Map(),
        taskItems: [],
        totalDurationMs: null,
        mode: reviewType === 'PR' ? 'pr' : 'code',
        acquisition: null,
        outcome: null,
        synthesisStarted: false,
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

    const mode: 'code' | 'pr' = reviewType
        ? reviewType === 'PR' ? 'pr' : 'code'
        : state.taskItems.length > 0 || state.clusterMap.size > 0 ? 'pr' : 'code'

    return {
        traceEntries: state.traceEntries,
        clusterMap: state.clusterMap,
        taskItems: state.taskItems,
        totalDurationMs: state.totalDurationMs,
        mode,
        acquisition: state.acquisition,
        outcome: state.outcome,
        synthesisStarted: state.synthesisStarted,
    }
}

/**
 * Replay a stored `ReviewStreamEvent[]` trace into the same structures `useReviewStream` builds live.
 * Pure synchronous computation wrapped in `useMemo` — runs once on mount (the trace never changes after load).
 */
export function useTraceReplay(
    traceLog: ReviewStreamEvent[] | null,
    reviewType?: 'CODE' | 'PR',
): TraceReplayResult {
    return useMemo(() => parseTraceLog(traceLog, reviewType), [traceLog, reviewType])
}
