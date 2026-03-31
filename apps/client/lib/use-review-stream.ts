'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from './api'
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
    /** Pre-fetch task board — one item per changed PR file. */
    taskItems: TaskItem[]
    /** Ordered trace entries — tool calls interleaved with thinking steps (single-agent path). */
    traceEntries: TraceEntry[]
    /**
     * Per-cluster trace state — only populated on the multi-agent clustered PR path.
     * Empty map on the single-agent (code review) path.
     */
    clusterMap: Map<string, ClusterState>
    review: ReviewData | null
    error: string | null
    /** Total wall-clock duration of the entire stream in milliseconds. */
    totalDurationMs: number | null
    /** Session inputs fetched when connecting to an existing stream. */
    sessionData: { type: 'CODE' | 'PR', input: string } | null
    /** Start a new review session and enqueue it. Returns the new reviewId. */
    submit: (payload: { code: string } | { prUrl: string }) => Promise<string | undefined>
    /** Reset all state to idle. */
    reset: () => void
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useReviewStream(initialReviewId?: string | null, githubToken?: string): UseReviewStreamReturn {
    const [phase, setPhase] = useState<StreamPhase>('idle')
    const [taskItems, setTaskItems] = useState<TaskItem[]>([])
    const [traceEntries, setTraceEntries] = useState<TraceEntry[]>([])
    const [clusterMap, setClusterMap] = useState<Map<string, ClusterState>>(new Map())
    const [review, setReview] = useState<ReviewData | null>(null)
    const [sessionData, setSessionData] = useState<{ type: 'CODE' | 'PR', input: string } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null)

    // Monotonically increasing counter for thinking entry IDs
    const thinkingSeqRef = useRef(0)
    const eventSourceRef = useRef<EventSource | null>(null)

    // ── Shared state reset ─────────────────────────────────────────────────────

    const resetState = useCallback(() => {
        setPhase('idle')
        setTaskItems([])
        setTraceEntries([])
        setClusterMap(new Map())
        setReview(null)
        setSessionData(null)
        setError(null)
        setTotalDurationMs(null)
    }, [])

    // ── Reset ─────────────────────────────────────────────────────────────────

    const reset = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
        }
        resetState()
    }, [resetState])

    // ── Submit (New Session + Enqueue) ────────────────────────────────────────

    const submit = useCallback(async (payload: { code: string } | { prUrl: string }): Promise<string | undefined> => {
        reset()
        setPhase('connecting')

        try {
            // 1. Create Session
            const type = 'code' in payload ? 'CODE' : 'PR'
            const input = 'code' in payload ? payload.code : payload.prUrl

            const sessionRes = await fetch(`${API_URL}/review/session`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
                },
                body: JSON.stringify({ type, input }),
            })

            let message = `HTTP ${sessionRes.status}`
            if (!sessionRes.ok) {
                const text = await sessionRes.text()
                try { message = (JSON.parse(text) as { message?: string }).message ?? message }
                catch { message = text || message }
                throw new Error(message)
            }

            const { reviewId } = await sessionRes.json()

            return reviewId
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to start review')
            setPhase('error')
            return undefined
        }
    }, [githubToken, reset])

    // ── Streaming (EventSource) ───────────────────────────────────────────────

    useEffect(() => {
        if (!initialReviewId) return

        resetState()
        setPhase('connecting')

        // Fire a background fetch to instantly paint the original query parameters that were
        // persisted to the DB on createSession, since EventSource doesn't pass these payloads.
        fetch(`${API_URL}/review/${initialReviewId}`, {
            headers: githubToken ? { Authorization: `Bearer ${githubToken}` } : {}
        })
            .then(res => res.json())
            .then(data => {
                if (data && data.input) setSessionData({ type: data.type, input: data.input })
            })
            .catch(() => null) // Ignore history fetch errors, stream might still succeed

        const url = `${API_URL}/review/${initialReviewId}/stream${githubToken ? `?token=${encodeURIComponent(githubToken)}` : ''}`
        const es = new EventSource(url)
        eventSourceRef.current = es

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
                    es.close()
                    break

                case 'error':
                    setError(event.message)
                    setPhase('error')
                    es.close()
                    break
            }
        }

        es.onmessage = (e: MessageEvent) => {
            try {
                dispatch(JSON.parse(e.data))
            } catch {
                // Ignore malformed events
            }
        }

        es.onerror = (e) => {
            if (es.readyState === EventSource.CLOSED) {
                // Error handled
            }
        }

        return () => {
            es.close()
            eventSourceRef.current = null
        }
    }, [initialReviewId, githubToken, resetState])

    return { phase, taskItems, traceEntries, clusterMap, sessionData, review, error, totalDurationMs, submit, reset }
}
