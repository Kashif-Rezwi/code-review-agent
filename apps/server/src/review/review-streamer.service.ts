import { Injectable, MessageEvent, Logger } from '@nestjs/common'
import { Observable } from 'rxjs'
import { RedisService } from '../queue/redis.service'
import { HistoryService } from '../history/history.service'

@Injectable()
export class ReviewStreamerService {
    private readonly logger = new Logger(ReviewStreamerService.name)

    constructor(
        private readonly redisService: RedisService,
        private readonly historyService: HistoryService,
    ) { }

    createStream(reviewId: string, userId: string): Observable<MessageEvent> {
        return new Observable<MessageEvent>((subscriber) => {
            let redisSub: ReturnType<typeof this.redisService.createSubscriber> | null = null;
            let isFinalized = false;

            const handleComplete = () => {
                isFinalized = true;
                if (redisSub) {
                    redisSub.quit().catch(() => {});
                    redisSub = null;
                }
                if (!subscriber.closed) {
                    subscriber.complete();
                }
            };

            // Start async setup phase
            (async () => {
                try {
                    // Domain check ensures the review belongs to this user before streaming
                    const review = await this.historyService.getReview(reviewId, userId);

                    // Replay Redis history synchronously
                    const history = await this.redisService.getLog(reviewId);
                    for (const msg of history) {
                        try {
                            const event = JSON.parse(msg);
                            subscriber.next({ data: event });
                        } catch {
                            subscriber.next({ data: msg });
                        }
                    }

                    // Database definitive status check
                    if (review.status === 'COMPLETE' || review.status === 'PARTIAL' || review.status === 'FAILED' || review.status === 'CANCELLED') {
                        if (history.length === 0) {
                            if (review.status === 'COMPLETE' || review.status === 'PARTIAL') {
                                subscriber.next({
                                    data: {
                                        type: 'complete',
                                        outcome: review.status === 'PARTIAL' ? 'partial' : 'complete',
                                        review: { id: review.id, coverage: review.coverage },
                                    },
                                });
                            } else {
                                subscriber.next({ data: { type: 'error', message: review.summary || (review.status === 'CANCELLED' ? 'Review cancelled' : 'Review failed') } });
                            }
                        }
                        handleComplete();
                        return;
                    }

                    if (subscriber.closed) return;

                    // Setup live Redis subscription
                    redisSub = this.redisService.createSubscriber();
                    await redisSub.subscribe(`re:${reviewId}`);
                    
                    redisSub.on('message', (channel, msg) => {
                        try {
                            const event = JSON.parse(msg);
                            subscriber.next({ data: event });
                            if (event.type === 'complete' || event.type === 'error') {
                                handleComplete();
                            }
                        } catch {
                            subscriber.next({ data: msg });
                        }
                    });

                } catch (err) {
                    this.logger.error(`Failed to initialize stream for ${reviewId}`, err);
                    if (!subscriber.closed) {
                        subscriber.error(err);
                    }
                }
            })();

            // Teardown callback on client disconnect
            return () => {
                if (!isFinalized && redisSub) {
                    redisSub.quit().catch(() => {});
                }
            };
        });
    }
}
