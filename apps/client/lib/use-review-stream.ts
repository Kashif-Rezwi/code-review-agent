'use client'

import { useCallback, useEffect, useRef, useReducer } from 'react'
import { API_URL, apiErrorMessage, reviewService } from './api'
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
    AcquisitionState,
} from './review-stream.reducer'

export type { TaskItem, TraceEntry, StreamPhase, ClusterState, ClusterFile, AcquisitionState }

export interface UseReviewStreamReturn {
    phase: StreamPhase
    taskItems: TaskItem[]
    traceEntries: TraceEntry[]
    clusterMap: Map<string, ClusterState>
    review: ReviewData | null
    error: string | null
    totalDurationMs: number | null
    acquisition: AcquisitionState | null
    outcome: 'complete' | 'partial' | null
    synthesisStarted: boolean
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
            let terminalReceived = false
            let lastEventId: string | undefined
            const seenEventIds = new Set<string>()
            const reconnectDelays = [500, 1_000, 2_000]
            try {
                for (let attempt = 0; attempt <= reconnectDelays.length; attempt++) {
                    const requestHeaders = { ...headers }
                    if (lastEventId) requestHeaders['Last-Event-ID'] = lastEventId
                    try {
                        const res = await fetch(`${API_URL}/review/${initialReviewId}/stream`, {
                            headers: requestHeaders,
                            signal: abortController.signal,
                        })

                        if (!res.ok || !res.body) throw new Error(await apiErrorMessage(res))

                        const reader = res.body.getReader()
                        await consumeSSEStream<ReviewStreamEvent>(reader, ({ id, event }) => {
                            if (id) {
                                lastEventId = id
                                if (seenEventIds.has(id)) return
                                seenEventIds.add(id)
                            }
                            if (event.type === 'heartbeat') return

                            let thinkingSeqId: number | undefined
                            if (event.type === 'thinking') thinkingSeqId = ++thinkingSeqRef.current
                            dispatch({ type: 'EVENT', event, thinkingSeqId })

                            if (event.type === 'complete' || event.type === 'error') terminalReceived = true
                        })

                        if (terminalReceived || abortController.signal.aborted) return
                        throw new Error('Review stream disconnected before a final result was received.')
                    } catch (error) {
                        if (abortController.signal.aborted) return
                        if (attempt >= reconnectDelays.length) throw error
                        await abortableDelay(reconnectDelays[attempt], abortController.signal)
                    }
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.name === 'AbortError') return
                dispatch({
                    type: 'EVENT',
                    event: {
                        type: 'error',
                        message: err instanceof Error ? err.message : 'Review stream disconnected unexpectedly.',
                    },
                })
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
        acquisition: state.acquisition,
        outcome: state.outcome,
        synthesisStarted: state.synthesisStarted,
        submit,
        reset
    }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
        }, milliseconds)
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
    })
}
