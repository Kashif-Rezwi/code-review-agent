'use client'

import { useCallback, useEffect, useRef, useReducer } from 'react'
import { API_URL, reviewService } from './api'
import { consumeSSEStream } from './sse'
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
    const eventSourceRef = useRef<AbortController | null>(null)

    const reset = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.abort()
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

            const { reviewId } = await reviewService.createSession({ type, input }, githubToken)

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

        reviewService.getSession(initialReviewId, githubToken)
            .then(data => {
                if (data && data.input) {
                    dispatch({ type: 'SET_SESSION_DATA', payload: { type: data.type, input: data.input } })
                }
            })
            .catch(() => null)

        const abortController = new AbortController()
        eventSourceRef.current = abortController // Store it so `reset` can abort it

        const headers: Record<string, string> = {
            'Accept': 'text/event-stream',
        }
        if (githubToken) {
            headers['Authorization'] = `Bearer ${githubToken}`
        }

        const startStream = async () => {
            try {
                const res = await fetch(`${API_URL}/review/${initialReviewId}/stream`, {
                    headers,
                    signal: abortController.signal
                })

                if (!res.ok || !res.body) {
                    throw new Error(`Connection failed with status ${res.status}`)
                }

                const reader = res.body.getReader()
                await consumeSSEStream<ReviewStreamEvent>(reader, (event) => {
                    let thinkingSeqId: number | undefined
                    if (event.type === 'thinking') {
                        thinkingSeqId = ++thinkingSeqRef.current
                    }

                    dispatch({ type: 'EVENT', event, thinkingSeqId })

                    // Notice: server will just close the connection on 'complete' / 'error'
                    // consumeSSEStream will return cleanly.
                })
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return
                // Ignore other errors, they could be network drops handled elsewhere or standard fetch errors
            }
        }

        startStream()

        return () => {
            abortController.abort()
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
