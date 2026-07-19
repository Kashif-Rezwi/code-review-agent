import { Injectable, Logger, type MessageEvent } from '@nestjs/common'
import { ReviewDataSchema, type ReviewData, type ReviewStreamEvent } from '@cra/types'
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
                    let review = await this.historyService.getReview(reviewId, userId)
                    reader = this.redisService.createConnection()
                    let lastId = isStreamId(suppliedLastId) ? suppliedLastId : '0-0'
                    let terminalDelivered = false

                    while (!stopped && !subscriber.closed) {
                        // A terminal row should replay immediately rather than wait for
                        // an empty 15-second blocking read.
                        const blockMs = TERMINAL_STATUSES.has(review.status) ? 0 : 15_000
                        let entries: RedisStreamEvent[]
                        try {
                            entries = await this.redisService.readEvents(reader, reviewId, lastId, blockMs)
                        } catch (error) {
                            review = await this.historyService.getReview(reviewId, userId)
                            if (TERMINAL_STATUSES.has(review.status)) {
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

                        review = await this.historyService.getReview(reviewId, userId)
                        if (TERMINAL_STATUSES.has(review.status)) {
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
    if (review.status === 'FAILED' || review.status === 'CANCELLED') {
        return {
            type: 'error',
            message: review.summary || (review.status === 'CANCELLED' ? 'Review cancelled' : 'Review failed'),
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
        durationMs: 0,
        stepCount: Array.isArray(review.traceLog) ? review.traceLog.length : 0,
        outcome: review.status === 'PARTIAL' ? 'partial' : 'complete',
    }
}

function isStreamId(value?: string): value is string {
    return typeof value === 'string' && /^(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/.test(value)
}
