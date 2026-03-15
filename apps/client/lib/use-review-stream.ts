'use client'

import { useCallback, useRef, useState } from 'react'
import { API_URL } from './api'
import { consumeSSEStream } from './sse'
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

export interface UseReviewStreamReturn {
    phase: StreamPhase
    /** Pre-fetch task board — one item per changed PR file. */
    taskItems: TaskItem[]
    /** Ordered trace entries — tool calls interleaved with thinking steps. */
    traceEntries: TraceEntry[]
    review: ReviewData | null
    error: string | null
    /** Total wall-clock duration of the entire stream in milliseconds. */
    totalDurationMs: number | null
    /** Number of tool calls made during the stream. */
    stepCount: number | null
    /** Start streaming a new review.  Pass `{ code }` or `{ prUrl }`. */
    submit: (payload: { code: string } | { prUrl: string }) => void
    /** Abort any in-progress stream and reset all state to idle. */
    reset: () => void
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useReviewStream(): UseReviewStreamReturn {
    const [phase, setPhase] = useState<StreamPhase>('idle')
    const [taskItems, setTaskItems] = useState<TaskItem[]>([])
    const [traceEntries, setTraceEntries] = useState<TraceEntry[]>([])
    const [review, setReview] = useState<ReviewData | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [totalDurationMs, setTotalDurationMs] = useState<number | null>(null)
    const [stepCount, setStepCount] = useState<number | null>(null)

    const abortRef = useRef<AbortController | null>(null)
    // Monotonically increasing counter for thinking entry IDs — kept in a ref
    // so it persists across renders without triggering re-renders, and is
    // scoped to this hook instance (no module-level global mutation).
    const thinkingSeqRef = useRef(0)

    // ── Shared state reset ─────────────────────────────────────────────────────
    // Used by both reset() and submit() to avoid duplicating the 6 setState calls.

    const resetState = useCallback(() => {
        setPhase('idle')
        setTaskItems([])
        setTraceEntries([])
        setReview(null)
        setError(null)
        setTotalDurationMs(null)
        setStepCount(null)
    }, [])

    // ── Reset ─────────────────────────────────────────────────────────────────

    const reset = useCallback(() => {
        abortRef.current?.abort()
        resetState()
    }, [resetState])

    // ── Submit ────────────────────────────────────────────────────────────────

    const submit = useCallback((payload: { code: string } | { prUrl: string }) => {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        resetState()
        setPhase('connecting')

        const endpoint = 'prUrl' in payload
            ? '/review/from-pr/stream'
            : '/review/from-code/stream'

        void (async () => {
            try {
                const response = await fetch(`${API_URL}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
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
                            // Initialise the task board with all files as "pending".
                            setTaskItems(event.tasks.map(t => ({ ...t, status: 'pending' as const })))
                            break

                        case 'task_update':
                            setTaskItems(prev => prev.map(t =>
                                t.id === event.taskId
                                    ? { ...t, status: event.status, detail: event.detail ?? t.detail }
                                    : t,
                            ))
                            break

                        case 'thinking': {
                            const seq = ++thinkingSeqRef.current
                            setTraceEntries(prev => [
                                ...prev,
                                { kind: 'thinking', id: `thinking-${seq}`, text: event.text },
                            ])
                            break
                        }

                        case 'tool_start':
                            setTraceEntries(prev => [
                                ...prev,
                                {
                                    kind: 'tool',
                                    id: event.callId,
                                    tool: event.tool,
                                    label: event.label,
                                    status: 'running',
                                    detail: event.detail,
                                },
                            ])
                            break

                        case 'tool_done':
                            setTraceEntries(prev =>
                                prev.map(e =>
                                    e.kind === 'tool' && e.id === event.callId
                                        ? {
                                            ...e,
                                            label: event.label || e.label,
                                            status: 'done' as const,
                                            detail: event.detail ?? e.detail,
                                            durationMs: event.durationMs,
                                        }
                                        : e,
                                ),
                            )
                            break

                        case 'complete':
                            setReview(event.review)
                            setTotalDurationMs(event.durationMs)
                            setStepCount(event.stepCount)
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
    }, [resetState])

    return { phase, taskItems, traceEntries, review, error, totalDurationMs, stepCount, submit, reset }
}
