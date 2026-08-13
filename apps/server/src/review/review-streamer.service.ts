import { Injectable, Logger, type MessageEvent } from '@nestjs/common'
import { ReviewDataSchema, type ReviewData, type ReviewStreamEvent } from '@cra/types'
import type { ReviewStatus } from '@prisma/client'
import type { Redis } from 'ioredis'
import { Observable } from 'rxjs'

import { HistoryService } from '../history/history.service'
import type { ReviewWithRelations } from '../history/history.repository'
import { RedisService, type RedisStreamEvent } from '../queue/redis.service'

const TERMINAL_STATUSES = new Set(['COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED'])

@Injectable()
export class ReviewStreamerService {
    private readonly logger = new Logger(ReviewStreamerService.name)

    constructor(
        private readonly redisService: RedisService,
        private readonly historyService: HistoryService,
    ) {}

    createStream(reviewId: string, userId: string, suppliedLastId?: string): Observable<MessageEvent> {
        return new Observable<MessageEvent>((subscriber) => {
            let reader: Redis | undefined
            let stopped = false

            const finish = async () => {
                if (stopped) return
                stopped = true
                if (reader) await reader.quit().catch(() => undefined)
                if (!subscriber.closed) subscriber.complete()
            }

            void (async () => {
                try {
                    // Full load once up front (ownership check + initial status); the poll
                    // loop below uses the status-only query to avoid re-loading
                    // issues/conversations on every cycle.
                    let status: ReviewStatus = (await this.historyService.getReview(reviewId, userId)).status
                    reader = this.redisService.createConnection()
                    let lastId = isStreamId(suppliedLastId) ? suppliedLastId : '0-0'
                    let terminalDelivered = false

                    while (!stopped && !subscriber.closed) {
                        // A terminal row should replay immediately rather than wait for
                        // an empty 15-second blocking read.
                        const blockMs = TERMINAL_STATUSES.has(status) ? 0 : 15_000
                        let entries: RedisStreamEvent[]
                        try {
                            entries = await this.redisService.readEvents(reader, reviewId, lastId, blockMs)
                        } catch (error) {
                            const latest = await this.historyService.getReviewStatus(reviewId, userId)
                            if (latest === null) {
                                await finish()
                                return
                            }
                            status = latest
                            if (TERMINAL_STATUSES.has(status)) {
                                const review = await this.historyService.getReview(reviewId, userId)
                                const terminal = reconstructTerminal(review)
                                subscriber.next({ type: terminal.type, data: terminal })
                                await finish()
                                return
                            }
                            throw error
                        }

                        for (const entry of entries) {
                            lastId = entry.id
                            const event = parseEvent(entry.message)
                            if (!event) continue
                            subscriber.next({ id: entry.id, type: event.type, data: event })
                            if (event.type === 'complete' || event.type === 'error') terminalDelivered = true
                        }

                        if (terminalDelivered) {
                            await finish()
                            return
                        }

                        const latest = await this.historyService.getReviewStatus(reviewId, userId)
                        if (latest === null) {
                            // Review was deleted mid-stream — close quietly.
                            await finish()
                            return
                        }
                        status = latest
                        if (TERMINAL_STATUSES.has(status)) {
                            const review = await this.historyService.getReview(reviewId, userId)
                            const terminal = reconstructTerminal(review)
                            subscriber.next({ type: terminal.type, data: terminal })
                            await finish()
                            return
                        }

                        if (entries.length === 0) {
                            // Heartbeats are intentionally not persisted in the Stream.
                            subscriber.next({ type: 'heartbeat', data: { type: 'heartbeat' } satisfies ReviewStreamEvent })
                        }
                    }
                } catch (error) {
                    if (stopped || subscriber.closed) return
                    this.logger.error(`Failed to stream review ${reviewId}`, error)
                    if (!subscriber.closed) subscriber.error(error)
                    await finish()
                }
            })()

            return () => {
                stopped = true
                // Interrupt a blocking XREAD immediately on browser teardown.
                reader?.disconnect()
            }
        })
    }
}

function parseEvent(message: string): ReviewStreamEvent | undefined {
    try {
        return JSON.parse(message) as ReviewStreamEvent
    } catch {
        return undefined
    }
}

function reconstructTerminal(review: ReviewWithRelations): ReviewStreamEvent {
    // The persisted trace ends with the original terminal event — recover the
    // real duration/step count (and failure message) instead of emitting zeros.
    const traceTerminal = lastTerminalFromTrace(review.traceLog)

    if (review.status === 'FAILED' || review.status === 'CANCELLED') {
        const traceMessage = traceTerminal?.type === 'error' && typeof traceTerminal.message === 'string'
            ? traceTerminal.message
            : undefined
        return {
            type: 'error',
            message: traceMessage ?? (review.summary || (review.status === 'CANCELLED' ? 'Review cancelled' : 'Review failed')),
        }
    }

    const candidate: ReviewData = {
        id: review.id,
        summary: review.summary ?? '',
        score: review.score ?? 1,
        positives: Array.isArray(review.positives) ? review.positives.filter((item): item is string => typeof item === 'string') : [],
        appliedStandards: Array.isArray(review.appliedStandards) ? review.appliedStandards.filter((item): item is string => typeof item === 'string') : [],
        coverage: review.coverage && typeof review.coverage === 'object' && !Array.isArray(review.coverage)
            ? review.coverage as ReviewData['coverage']
            : undefined,
        issues: review.issues.map((issue) => ({
            type: issue.type.toLowerCase() as ReviewData['issues'][number]['type'],
            severity: issue.severity.toLowerCase() as ReviewData['issues'][number]['severity'],
            title: issue.title,
            location: issue.location,
            description: issue.description,
            recommendation: issue.recommendation,
        })),
    }

    return {
        type: 'complete',
        review: ReviewDataSchema.parse(candidate),
        durationMs: typeof traceTerminal?.durationMs === 'number' ? traceTerminal.durationMs : 0,
        stepCount: typeof traceTerminal?.stepCount === 'number'
            ? traceTerminal.stepCount
            : Array.isArray(review.traceLog) ? review.traceLog.length : 0,
        outcome: review.status === 'PARTIAL' ? 'partial' : 'complete',
    }
}

/** Find the terminal event (`complete`/`error`) the pipeline appended to the trace. */
function lastTerminalFromTrace(traceLog: unknown): Record<string, unknown> | undefined {
    if (!Array.isArray(traceLog)) return undefined
    for (let index = traceLog.length - 1; index >= 0; index--) {
        const entry: unknown = traceLog[index]
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const type = (entry as Record<string, unknown>).type
            if (type === 'complete' || type === 'error') return entry as Record<string, unknown>
        }
    }
    return undefined
}

function isStreamId(value?: string): value is string {
    return typeof value === 'string' && /^(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/.test(value)
}
