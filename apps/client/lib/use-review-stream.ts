'use client'

import { useCallback, useEffect, useRef, useReducer } from 'react'
import { API_URL, apiFetch } from './api'
import type { ReviewData, ReviewStreamEvent } from '@/types/review.types'
import {
    reviewStreamReducer,
    initialReviewStreamState,
    TaskItem,
    TraceEntry,
    StreamPhase,
    ClusterState,
    ClusterFile,
} from './review-stream.reducer'

export type { TaskItem, TraceEntry, StreamPhase, ClusterState, ClusterFile }

export interface UseReviewStreamReturn {
    phase: StreamPhase
    taskItems: TaskItem[]
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    review: ReviewData | null
    error: string | null
    totalDurationMs: number | null
    sessionData: { type: 'CODE' | 'PR'; input: string } | null
    submit: (payload: { code: string } | { prUrl: string }) => Promise<string | undefined>
    reset: () => void
}

export function useReviewStream(initialReviewId?: string | null, githubToken?: string): UseReviewStreamReturn {
    const [state, dispatch] = useReducer(reviewStreamReducer, initialReviewStreamState)
    
    const thinkingSeqRef = useRef(0)
    const eventSourceRef = useRef<EventSource | null>(null)

    const reset = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
        }
        dispatch({ type: 'RESET' })
        thinkingSeqRef.current = 0
    }, [])

    const submit = useCallback(async (payload: { code: string } | { prUrl: string }): Promise<string | undefined> => {
        reset()
        dispatch({ type: 'SET_CONNECTING' })

        try {
            const type = 'code' in payload ? 'CODE' : 'PR'
            const input = 'code' in payload ? payload.code : payload.prUrl

            const { reviewId } = await apiFetch<{ reviewId: string }>('/review/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, input }),
            }, githubToken)

            return reviewId
        } catch (err) {
            dispatch({
                type: 'EVENT',
                event: { type: 'error', message: err instanceof Error ? err.message : 'Failed to start review' }
            })
            return undefined
        }
    }, [githubToken, reset])

    useEffect(() => {
        if (!initialReviewId) return

        dispatch({ type: 'RESET' })
        dispatch({ type: 'SET_CONNECTING' })

        apiFetch<{ type: 'CODE' | 'PR'; input: string }>(`/review/${initialReviewId}`, undefined, githubToken)
            .then(data => {
                if (data && data.input) {
                    dispatch({ type: 'SET_SESSION_DATA', payload: { type: data.type, input: data.input } })
                }
            })
            .catch(() => null)

        const url = `${API_URL}/review/${initialReviewId}/stream${githubToken ? `?token=${encodeURIComponent(githubToken)}` : ''}`
        const es = new EventSource(url)
        eventSourceRef.current = es

        es.onmessage = (e: MessageEvent) => {
            try {
                const event = JSON.parse(e.data) as ReviewStreamEvent
                
                let thinkingSeqId: number | undefined
                if (event.type === 'thinking') {
                    thinkingSeqId = ++thinkingSeqRef.current
                }
                
                dispatch({ type: 'EVENT', event, thinkingSeqId })

                if (event.type === 'complete' || event.type === 'error') {
                    es.close()
                }
            } catch {
                // Ignore malformed events
            }
        }

        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) {
                // Error handled
            }
        }

        return () => {
            es.close()
            eventSourceRef.current = null
        }
    }, [initialReviewId, githubToken])

    return {
        phase: state.phase,
        taskItems: state.taskItems,
        traceEntries: state.traceEntries,
        clusterMap: state.clusterMap,
        sessionData: state.sessionData,
        review: state.review,
        error: state.error,
        totalDurationMs: state.totalDurationMs,
        submit,
        reset
    }
}
