import {
    CallHandler,
    ExecutionContext,
    Injectable,
    Logger,
    NestInterceptor,
} from '@nestjs/common'
import { Observable, from, throwError } from 'rxjs'
import { catchError, concatMap } from 'rxjs/operators'
import type { Request } from 'express'
import { PaymentsService } from './payments.service'

/**
 * Refunds pre-deducted credits when a request fails *before the handler completes*
 * (R-01 — guards run before pipes).
 *
 * NestJS execution order: Guards → Interceptors (pre) → Pipes → Handler → Interceptors (post).
 * `CreditGuard` (a guard) deducts credits and sets `req.creditDeducted` / `req.creditUserId`.
 * If the subsequent `ValidationPipe` rejects the body (400), the handler never runs and the
 * S-03/S-04 handler-level refund (which lives inside the handler's catch block) never fires.
 *
 * This interceptor wraps `next.handle()` with a `catchError` that detects the markers left
 * by `CreditGuard` and refunds before re-throwing the original exception. The built-in
 * NestJS exception filter then formats the HTTP response normally.
 *
 * Double-refund prevention:
 * - The S-03 handler catch block (review) refunds and **clears** the markers before
 *   re-throwing, so this interceptor sees no markers and skips.
 * - The S-04 chat stream error is handled inside the Observable's async IIFE; the
 *   Observable *completes* (does not error), so this interceptor's `catchError` never fires.
 * - Guard-level exceptions (402 insufficient credits, 429 throttled) occur *before* this
 *   interceptor's `next.handle()` is called, so they bypass it entirely — and `CreditGuard`
 *   does not set markers when it throws 402 (insufficient balance).
 */
@Injectable()
export class CreditRefundInterceptor implements NestInterceptor {
    private readonly logger = new Logger(CreditRefundInterceptor.name)

    constructor(private readonly paymentsService: PaymentsService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const req = context.switchToHttp().getRequest<
            Request & { creditDeducted?: number; creditUserId?: string }
        >()

        return next.handle().pipe(
            catchError((err: unknown) => {
                // No markers = CreditGuard didn't deduct (or the handler already refunded
                // and cleared them). Just re-throw.
                if (!req.creditDeducted || !req.creditUserId) {
                    return throwError(() => err)
                }

                const cost = req.creditDeducted
                const userId = req.creditUserId
                // Clear markers immediately so no downstream handler can double-refund.
                req.creditDeducted = undefined
                req.creditUserId = undefined

                // Refund, then re-throw the original exception regardless of refund success.
                return from(
                    this.paymentsService
                        .refundCredits({
                            userId,
                            cost,
                            reviewId: null,
                            description: 'Refund: request rejected before handler completed (R-01)',
                        })
                        .catch((refundErr: unknown) => {
                            this.logger.error(
                                `Failed to refund ${cost} credits for user ${userId} after pre-handler exception: ` +
                                    `${
                                        refundErr instanceof Error
                                            ? refundErr.message
                                            : String(refundErr)
                                    }`,
                            )
                        }),
                ).pipe(concatMap(() => throwError(() => err)))
            }),
        )
    }
}