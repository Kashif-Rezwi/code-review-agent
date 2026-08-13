import {
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { CREDIT_COST_KEY, type CreditCostResolver } from './credit-cost.decorator'
import { PaymentsService } from './payments.service'
import type { AuthUser } from '../auth/auth.guard'

// Extend Express Request so TypeScript knows about the fields we set.
declare module 'express' {
    interface Request {
        creditDeducted?: number
        creditUserId?: string
    }
}

/**
 * Guards an endpoint by atomically deducting credits before the handler runs.
 * Must be applied AFTER AuthGuard (class-level) so req.user is populated.
 *
 * Security note (F-06): guards execute before ValidationPipe.
 * If a resolver function reads req.body, it MUST strictly validate the values
 * and throw BadRequestException on unexpected values (never falling through to 0 or free execution).
 *
 * If the cost metadata is missing, zero, or invalid, throws 500.
 * If the user's balance is insufficient, throws 402.
 */
@Injectable()
export class CreditGuard implements CanActivate {
    private readonly logger = new Logger(CreditGuard.name)

    constructor(
        private readonly reflector: Reflector,
        private readonly paymentsService: PaymentsService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const costResolver = this.reflector.get<CreditCostResolver>(CREDIT_COST_KEY, context.getHandler())
        const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>()

        let cost: number
        if (typeof costResolver === 'function') {
            cost = costResolver(req)
        } else if (typeof costResolver === 'number') {
            cost = costResolver
        } else {
            throw new InternalServerErrorException(
                'CreditGuard is applied to a route without a valid @CreditCost decorator.',
            )
        }

        // Missing or zero/negative cost = implementation bug or invalid calculation.
        if (!cost || cost <= 0 || !Number.isInteger(cost)) {
            throw new InternalServerErrorException(
                'CreditGuard cost must be a positive integer.',
            )
        }

        const userId = req.user?.userId
        if (!userId) {
            // AuthGuard must run before CreditGuard. If we get here without a user, it's a wiring bug.
            throw new InternalServerErrorException('CreditGuard requires AuthGuard to run first.')
        }

        const balanceAfter = await this.paymentsService.deductCredits({
            userId,
            cost,
            reviewId: null,
            description: `Pre-deduction for ${context.getHandler()?.name ?? 'route'}`,
        })

        if (balanceAfter === null) {
            this.logger.warn(`Insufficient credits for user ${userId} (cost: ${cost})`)
            throw new HttpException(
                { statusCode: HttpStatus.PAYMENT_REQUIRED, message: 'Insufficient credits. Please top up your balance.' },
                HttpStatus.PAYMENT_REQUIRED,
            )
        }

        // Store deducted amount on the request so downstream error handlers can issue a refund.
        req.creditDeducted = cost
        req.creditUserId = userId

        return true
    }
}
