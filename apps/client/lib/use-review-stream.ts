'use client'

import { useCallback, useRef, useState } from 'react'
import { API_URL } from './api'
import { consumeSSEStream } from './sse'
import { parseTraceLog } from './use-trace-replay'
import type { ReviewData, ReviewStreamEvent } from '@/types/review.types'

// ── Public types ──────────────────────────────────────────────────────────────

/** A file task in the pre-fetch task board. */
export type TaskItem = {
    id: string
    label: string
    status: 'pending' | 'running' | 'done'
    detail?: string
}

/** A single entry in the agent trace timeline. */
export type TraceEntry =
    | { kind: 'tool'; id: string; tool: string; label: string; status: 'running' | 'done'; detail?: string; durationMs?: number }
    | { kind: 'thinking'; id: string; text: string }

export type StreamPhase = 'idle' | 'connecting' | 'streaming' | 'complete' | 'error'

/** Diff stats for a single file within a cluster. */
export type ClusterFile = {
    name: string
    additions: number
    deletions: number
    status: string
}

/** Per-cluster state collected during the multi-agent clustered PR review path. */
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

export interface UseReviewStreamReturn {
    phase: StreamPhase
    taskItems: TaskItem[]
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    review: ReviewData | null
    error: string | null
    totalDurationMs: number | null
    /** Connect to an existing review session and begin streaming. */
    submit: (reviewId: string) => void
    /** Instantly hydrate state from an already completed review */
    hydrate: (review: ReviewData, traceLog: ReviewStreamEvent[] | null, errorMsg?: string | null) => void
    reset: () => void
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useReviewStream(githubToken?: string): UseReviewStreamReturn {
    const [phase, setPhase] = useState<StreamPhase>('idle')
    const [taskItems, setTaskItems] = useState<TaskItem[]>([])
    const [traceEntries, setTraceEntries] = useState<TraceEntry[]>([])
    const [clusterMap, setClusterMap] = useState<Map<string, ClusterState>>(new Map())
    const [review, setReview] = useState<ReviewData | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null)

    const abortRef = useRef<AbortController | null>(null)
    const thinkingSeqRef = useRef(0)

    const resetState = useCallback(() => {
        setPhase('idle')
        setTaskItems([])
        setTraceEntries([])
        setClusterMap(new Map())
        setReview(null)
        setError(null)
        setTotalDurationMs(null)
    }, [])

    const reset = useCallback(() => {
        abortRef.current?.abort()
        resetState()
    }, [resetState])

    const hydrate = useCallback((reviewData: ReviewData, traceLog: ReviewStreamEvent[] | null, errorMsg?: string | null) => {
        abortRef.current?.abort()
        const { traceEntries: hyTrace, clusterMap: hyMap, taskItems: hyTask, totalDurationMs: hyDur } = parseTraceLog(traceLog)
        
        if (errorMsg) {
            setPhase('error')
            setError(errorMsg)
        } else {
            setPhase('complete')
            setError(null)
        }
        
        setReview(reviewData)
        setTraceEntries(hyTrace)
        setClusterMap(hyMap)
        setTaskItems(hyTask)
        setTotalDurationMs(hyDur)
    }, [])

    const submit = useCallback((reviewId: string) => {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        resetState()
        setPhase('connecting')

        void (async () => {
            try {
                // 1. Enqueue the job (idempotent, harmless if already enqueued)
                const enqRes = await fetch(`${API_URL}/review/enqueue`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
                    },
                    body: JSON.stringify({ reviewId }),
                    signal: controller.signal,
                })

                if (!enqRes.ok) {
                    const text = await enqRes.text()
                    throw new Error(`Enqueue failed: ${text}`)
                }

                // 2. Consume SSE stream via GET
                const response = await fetch(`${API_URL}/review/${reviewId}/stream`, {
                    method: 'GET',
                    headers: {
                        'Accept': 'text/event-stream',
                        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
                    },
                    signal: controller.signal,
                })

                if (!response.ok) {
                    const text = await response.text()
                    let message = `HTTP ${response.status}`
                    try { message = (JSON.parse(text) as { message?: string }).message ?? message }
                    catch { message = text || message }
                    setError(message)
                    setPhase('error')
                    return
                }

                const reader = response.body!.getReader()

                const dispatch = (event: ReviewStreamEvent) => {
                    switch (event.type) {
                        case 'start':
                            setPhase('streaming')
                            break

                        case 'task_plan':
                            setTaskItems(event.tasks.map(t => ({ ...t, status: 'pending' as const })))
                            break

                        case 'task_update':
                            setTaskItems(prev => prev.map(t =>
                                t.id === event.taskId
                                    ? { ...t, status: event.status, detail: event.detail ?? t.detail }
                                    : t,
                            ))
                            break

                        case 'cluster_plan':
                            setClusterMap(() => {
                                const m = new Map<string, ClusterState>()
                                for (const c of event.clusters) {
                                    m.set(c.id, {
                                        ...c,
                                        files: c.files ?? [],
                                        traceEntries: [],
                                        done: false,
                                    })
                                }
                                return m
                            })
                            break

                        case 'cluster_done':
                            setClusterMap(prev => {
                                const m = new Map(prev)
                                const existing = m.get(event.clusterId)
                                if (existing) {
                                    m.set(event.clusterId, {
                                        ...existing,
                                        issueCount: event.issueCount,
                                        durationMs: event.durationMs,
                                        done: true,
                                    })
                                }
                                return m
                            })
                            break

                        case 'thinking': {
                            const seq = ++thinkingSeqRef.current
                            const entry: TraceEntry = { kind: 'thinking', id: `thinking-${seq}`, text: event.text }
                            if (event.clusterId) {
                                const cid = event.clusterId
                                setClusterMap(prev => {
                                    const m = new Map(prev)
                                    const c = m.get(cid)
                                    if (c) m.set(cid, { ...c, traceEntries: [...c.traceEntries, entry] })
                                    return m
                                })
                            } else {
                                setTraceEntries(prev => [...prev, entry])
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
                                const cid = event.clusterId
                                setClusterMap(prev => {
                                    const m = new Map(prev)
                                    const c = m.get(cid)
                                    if (c) m.set(cid, { ...c, traceEntries: [...c.traceEntries, entry] })
                                    return m
                                })
                            } else {
                                setTraceEntries(prev => [...prev, entry])
                            }
                            break
                        }

                        case 'tool_done':
                            if (event.clusterId) {
                                const cid = event.clusterId
                                setClusterMap(prev => {
                                    const m = new Map(prev)
                                    const c = m.get(cid)
                                    if (!c) return prev
                                    const updated = c.traceEntries.map(e =>
                                        e.kind === 'tool' && e.id === event.callId
                                            ? { ...e, label: event.label || e.label, status: 'done' as const, detail: event.detail ?? e.detail, durationMs: event.durationMs }
                                            : e,
                                    )
                                    m.set(cid, { ...c, traceEntries: updated })
                                    return m
                                })
                            } else {
                                setTraceEntries(prev =>
                                    prev.map(e =>
                                        e.kind === 'tool' && e.id === event.callId
                                            ? { ...e, label: event.label || e.label, status: 'done' as const, detail: event.detail ?? e.detail, durationMs: event.durationMs }
                                            : e,
                                    ),
                                )
                            }
                            break

                        case 'complete':
                            setClusterMap(prev => {
                                const m = new Map(prev)
                                for (const [id, c] of m) {
                                    if (!c.done) m.set(id, { ...c, done: true })
                                }
                                return m
                            })
                            setReview(event.review)
                            setTotalDurationMs(event.durationMs)
                            setPhase('complete')
                            break

                        case 'error':
                            setError(event.message)
                            setPhase('error')
                            break
                    }
                }

                await consumeSSEStream<ReviewStreamEvent>(reader, dispatch)
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') return
                setError(err instanceof Error ? err.message : 'Stream failed')
                setPhase('error')
            }
        })()
    }, [githubToken, resetState])

    return { phase, taskItems, traceEntries, clusterMap, review, error, totalDurationMs, submit, hydrate, reset }
}
