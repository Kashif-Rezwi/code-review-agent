import { Body, Controller, Get, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Request } from 'express'
import { AuthGuard } from '../auth/auth.guard'
import { UserThrottlerGuard } from '../throttle/user-throttler.guard'
import { PaymentsService } from './payments.service'
import { CreateOrderDto } from './dto/create-order.dto'

/**
 * Authenticated payment endpoints.
 * All routes here require a valid GitHub Bearer token (AuthGuard at class level).
 * The webhook route lives in WebhookController (no AuthGuard there).
 */
@UseGuards(AuthGuard)
@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) {}

    /**
     * Create a Razorpay order and return the data needed to open Checkout.js.
     * Rate-limited to 5 per user per hour to prevent abandoned-order accumulation.
     */
    @Post('order')
    @HttpCode(201)
    @UseGuards(UserThrottlerGuard)
    @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
    async createOrder(
        @Body() dto: CreateOrderDto,
        @Req() req: Request,
        @Headers('x-dev-pack') devPack?: string,
    ) {
        // userId is always from req.user (set by AuthGuard) — never trusted from the body.
        return this.paymentsService.createOrder(dto.packageId, req.user!.userId, devPack)
    }

    /** Return the authenticated user's credit balance, recent ledger, and available packages. */
    @Get('wallet')
    @UseGuards(UserThrottlerGuard)
    @Throttle({ default: { limit: 60, ttl: 60_000 } }) // F-12: 60/min per user
    getWallet(@Req() req: Request, @Headers('x-dev-pack') devPack?: string) {
        return this.paymentsService.getWallet(req.user!.userId, devPack)
    }
}
