import type { ReviewData, ReviewStreamEvent } from '@/types/review.types'

// ── Public Types ──────────────────────────────────────────────────────────────

export type TaskItem = {
    id: string
    label: string
    status: 'pending' | 'running' | 'done'
    detail?: string
}

export type TraceEntry =
    | { kind: 'tool'; id: string; tool: string; label: string; status: 'running' | 'done'; detail?: string; durationMs?: number }
    | { kind: 'thinking'; id: string; text: string }

export type StreamPhase = 'idle' | 'connecting' | 'streaming' | 'complete' | 'error'

export type ClusterFile = {
    name: string
    additions: number
    deletions: number
    status: string
}

export type ClusterState = {
    id: string
    label: string
    focus: string
    files: ClusterFile[]
    traceEntries: TraceEntry[]
    issueCount?: number
    durationMs?: number
    done: boolean
    failed?: boolean
    error?: string
    attempts?: number
}

export type AcquisitionState = Extract<ReviewStreamEvent, { type: 'acquisition' }>
type PendingClusterEvent = { event: ReviewStreamEvent; thinkingSeqId?: number }

export interface ReviewStreamState {
    phase: StreamPhase
    taskItems: TaskItem[]
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    review: ReviewData | null
    sessionData: { type: 'CODE' | 'PR'; input: string } | null
    error: string | null
    totalDurationMs: number | null
    acquisition: AcquisitionState | null
    outcome: 'complete' | 'partial' | null
    synthesisStarted: boolean
    pendingClusterEvents: Map<string, PendingClusterEvent[]>
}

export const initialReviewStreamState: ReviewStreamState = {
    phase: 'idle',
    taskItems: [],
    traceEntries: [],
    clusterMap: new Map(),
    review: null,
    sessionData: null,
    error: null,
    totalDurationMs: null,
    acquisition: null,
    outcome: null,
    synthesisStarted: false,
    pendingClusterEvents: new Map(),
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type Action =
    | { type: 'RESET' }
    | { type: 'SET_CONNECTING' }
    | { type: 'SET_SESSION_DATA'; payload: { type: 'CODE' | 'PR'; input: string } | null }
    | {
          type: 'EVENT'
          event: ReviewStreamEvent
          thinkingSeqId?: number
      }

// ── Reducer ───────────────────────────────────────────────────────────────────

export function reviewStreamReducer(state: ReviewStreamState, action: Action): ReviewStreamState {
    switch (action.type) {
        case 'RESET':
            return { ...initialReviewStreamState, clusterMap: new Map(), pendingClusterEvents: new Map() }

        case 'SET_CONNECTING':
            return { ...state, phase: 'connecting' }

        case 'SET_SESSION_DATA':
            return { ...state, sessionData: action.payload }

        case 'EVENT': {
            const { event } = action
            switch (event.type) {
                case 'heartbeat':
                    return state

                case 'start':
                    return { ...state, phase: 'streaming' }

                case 'acquisition':
                    return { ...state, acquisition: event }

                case 'task_plan':
                    return {
                        ...state,
                        taskItems: event.tasks.map(t => ({ ...t, status: 'pending' as const })),
                    }

                case 'task_update':
                    return {
                        ...state,
                        taskItems: state.taskItems.map(t =>
                            t.id === event.taskId
                                ? { ...t, status: event.status, detail: event.detail ?? t.detail }
                                : t
                        ),
                    }

                case 'cluster_plan': {
                    const nextMap = new Map<string, ClusterState>()
                    for (const c of event.clusters) {
                        nextMap.set(c.id, {
                            ...c,
                            files: c.files ?? [],
                            traceEntries: [],
                            done: false,
                        })
                    }
                    let nextState: ReviewStreamState = {
                        ...state,
                        clusterMap: nextMap,
                        pendingClusterEvents: new Map(),
                    }
                    for (const pending of state.pendingClusterEvents.values()) {
                        for (const item of pending) {
                            nextState = reviewStreamReducer(nextState, {
                                type: 'EVENT',
                                event: item.event,
                                thinkingSeqId: item.thinkingSeqId,
                            })
                        }
                    }
                    return nextState
                }

                case 'cluster_done': {
                    const nextMap = new Map(state.clusterMap)
                    const existing = nextMap.get(event.clusterId)
                    if (existing) {
                        nextMap.set(event.clusterId, {
                            ...existing,
                            issueCount: event.issueCount,
                            durationMs: event.durationMs,
                            attempts: event.attempts,
                            done: true,
                        })
                    } else {
                        return bufferClusterEvent(state, event.clusterId, event, action.thinkingSeqId)
                    }
                    return { ...state, clusterMap: nextMap }
                }

                case 'cluster_failed': {
                    const nextMap = new Map(state.clusterMap)
                    const existing = nextMap.get(event.clusterId)
                    if (!existing) return bufferClusterEvent(state, event.clusterId, event, action.thinkingSeqId)
                    nextMap.set(event.clusterId, {
                        ...existing,
                        durationMs: event.durationMs,
                        attempts: event.attempts,
                        done: true,
                        failed: true,
                        error: event.message,
                    })
                    return { ...state, clusterMap: nextMap }
                }

                case 'synthesis_start':
                    return { ...state, synthesisStarted: true }

                case 'thinking': {
                    const entry: TraceEntry = {
                        kind: 'thinking',
                        id: `thinking-${action.thinkingSeqId ?? Date.now()}`,
                        text: event.text,
                    }

                    if (event.clusterId) {
                        const cid = event.clusterId
                        const nextMap = new Map(state.clusterMap)
                        const c = nextMap.get(cid)
                        if (c) {
                            nextMap.set(cid, { ...c, traceEntries: [...c.traceEntries, entry] })
                        } else {
                            return bufferClusterEvent(state, cid, event, action.thinkingSeqId)
                        }
                        return { ...state, clusterMap: nextMap }
                    } else {
                        return { ...state, traceEntries: [...state.traceEntries, entry] }
                    }
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
                        const cid = event.clusterId
                        const nextMap = new Map(state.clusterMap)
                        const c = nextMap.get(cid)
                        if (c) {
                            nextMap.set(cid, { ...c, traceEntries: [...c.traceEntries, entry] })
                        } else {
                            return bufferClusterEvent(state, cid, event, action.thinkingSeqId)
                        }
                        return { ...state, clusterMap: nextMap }
                    } else {
                        return { ...state, traceEntries: [...state.traceEntries, entry] }
                    }
                }

                case 'tool_done': {
                    if (event.clusterId) {
                        const cid = event.clusterId
                        const nextMap = new Map(state.clusterMap)
                        const c = nextMap.get(cid)
                        if (c) {
                            const updated = c.traceEntries.map(e =>
                                e.kind === 'tool' && e.id === event.callId
                                    ? {
                                          ...e,
                                          label: event.label || e.label,
                                          status: 'done' as const,
                                          detail: event.detail ?? e.detail,
                                          durationMs: event.durationMs,
                                      }
                                    : e
                            )
                            nextMap.set(cid, { ...c, traceEntries: updated })
                        } else {
                            return bufferClusterEvent(state, cid, event, action.thinkingSeqId)
                        }
                        return { ...state, clusterMap: nextMap }
                    } else {
                        const updated = state.traceEntries.map(e =>
                            e.kind === 'tool' && e.id === event.callId
                                ? {
                                      ...e,
                                      label: event.label || e.label,
                                      status: 'done' as const,
                                      detail: event.detail ?? e.detail,
                                      durationMs: event.durationMs,
                                  }
                                : e
                        )
                        return { ...state, traceEntries: updated }
                    }
                }

                case 'complete': {
                    const nextMap = new Map(state.clusterMap)
                    for (const [id, c] of nextMap) {
                        if (!c.done) nextMap.set(id, { ...c, done: true })
                    }
                    return {
                        ...state,
                        clusterMap: nextMap,
                        review: event.review,
                        totalDurationMs: event.durationMs,
                        outcome: event.outcome ?? 'complete',
                        phase: 'complete',
                    }
                }

                case 'error':
                    return {
                        ...state,
                        error: event.message,
                        phase: 'error',
                    }

                default:
                    return state
            }
        }

        default:
            return state
    }
}

function bufferClusterEvent(
    state: ReviewStreamState,
    clusterId: string,
    event: ReviewStreamEvent,
    thinkingSeqId?: number,
): ReviewStreamState {
    const pending = new Map(state.pendingClusterEvents)
    pending.set(clusterId, [...(pending.get(clusterId) ?? []), { event, thinkingSeqId }])
    return { ...state, pendingClusterEvents: pending }
}
