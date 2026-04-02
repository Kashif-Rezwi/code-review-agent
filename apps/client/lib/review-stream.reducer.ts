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
}

export interface ReviewStreamState {
    phase: StreamPhase
    taskItems: TaskItem[]
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    review: ReviewData | null
    sessionData: { type: 'CODE' | 'PR'; input: string } | null
    error: string | null
    totalDurationMs: number | null
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
            return { ...initialReviewStreamState }

        case 'SET_CONNECTING':
            return { ...state, phase: 'connecting' }

        case 'SET_SESSION_DATA':
            return { ...state, sessionData: action.payload }

        case 'EVENT': {
            const { event } = action
            switch (event.type) {
                case 'start':
                    return { ...state, phase: 'streaming' }

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
                    return { ...state, clusterMap: nextMap }
                }

                case 'cluster_done': {
                    const nextMap = new Map(state.clusterMap)
                    const existing = nextMap.get(event.clusterId)
                    if (existing) {
                        nextMap.set(event.clusterId, {
                            ...existing,
                            issueCount: event.issueCount,
                            durationMs: event.durationMs,
                            done: true,
                        })
                    }
                    return { ...state, clusterMap: nextMap }
                }

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
