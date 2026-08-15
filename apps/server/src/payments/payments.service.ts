import * as crypto from 'crypto'
import {
    BadGatewayException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Razorpay from 'razorpay'
import { CREDIT_PACKAGES, FREE_CREDIT_AMOUNT } from './credit-cost.policy'
import { PaymentsRepository } from './payments.repository'
import type { WalletResponse } from '@cra/types'
import { Prisma } from '@prisma/client'

/** Maximum pending orders allowed per user before we reject new order creation (F-11). */
const MAX_PENDING_ORDERS = 3

/** Maximum raw webhook body size in bytes — reject before HMAC (F-03). */
const WEBHOOK_MAX_BODY_BYTES = 1_048_576 // 1 MB

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name)
    private readonly razorpay: Razorpay
    private readonly webhookSecret: string

    constructor(
        private readonly config: ConfigService,
        private readonly repo: PaymentsRepository,
    ) {
        this.razorpay = new Razorpay({
            key_id: this.config.getOrThrow<string>('RAZORPAY_KEY_ID'),
            key_secret: this.config.getOrThrow<string>('RAZORPAY_KEY_SECRET'),
        })
        this.webhookSecret = this.config.getOrThrow<string>('RAZORPAY_WEBHOOK_SECRET')
    }

    /**
     * Create a Razorpay order and persist a local PaymentOrder row.
     * Validates packageId, enforces pending order cap (F-11), calls Razorpay API,
     * and stores the local order record.
     */
    async createOrder(packageId: string, userId: string) {
        const pkg = CREDIT_PACKAGES[packageId]
        // DTO @IsIn validation already guards this — belt-and-suspenders.
        if (!pkg) throw new Error(`Unknown packageId: ${packageId}`)

        // F-11: Pending order cap — prevent unbounded abandoned orders.
        const pendingCount = await this.repo.countPendingOrders(userId)
        if (pendingCount >= MAX_PENDING_ORDERS) {
            throw new HttpException(
                'You have too many pending orders — please complete or wait for them to expire.',
                HttpStatus.TOO_MANY_REQUESTS,
            )
        }

        const internalOrderId = crypto.randomUUID()

        // Call Razorpay Orders API — do NOT include userId in notes (F-10, avoids PII in dashboard).
        let razorpayOrder: { id: string; amount: number; currency: string }
        try {
            razorpayOrder = await this.razorpay.orders.create({
                amount: pkg.amountPaise,
                currency: pkg.currency,
                receipt: internalOrderId,
                notes: { packageId },
            }) as { id: string; amount: number; currency: string }
        } catch (err) {
            // Sanitise SDK error — do NOT log raw error object (F-10, may contain API keys in headers).
            const msg = err instanceof Error ? err.message : 'Razorpay API error'
            this.logger.error(`Razorpay order creation failed: ${msg}`)
            throw new BadGatewayException('Payment service unavailable. Please try again later.')
        }

        // Persist local order record.
        const localOrder = await this.repo.createOrder({
            id: internalOrderId,
            userId,
            razorpayOrderId: razorpayOrder.id,
            packageId,
            amountPaise: pkg.amountPaise,
            currency: pkg.currency,
            creditsGranted: pkg.credits, // R-02: persist at creation time, read at capture time
        })

        return {
            orderId: localOrder.id,
            razorpayOrderId: razorpayOrder.id,
            amount: pkg.amountPaise,
            currency: pkg.currency,
            keyId: this.config.getOrThrow<string>('RAZORPAY_KEY_ID'),
        }
    }

    /**
     * Process an incoming Razorpay webhook.
     * Verifies HMAC signature (F-01, F-02), then routes by event type.
     * Returns 'ok' on success, throws UnauthorizedException on bad signature.
     *
     * Body-size check must happen in the controller BEFORE calling this (F-03).
     */
    async handleWebhook(rawBody: Buffer, signatureHeader: string, eventId: string): Promise<void> {
        // F-02: Validate signature header format before timingSafeEqual (prevents RangeError on length mismatch).
        if (!/^[0-9a-f]{64}$/.test(signatureHeader)) {
            throw new UnauthorizedException('Invalid webhook signature format.')
        }

        // F-01: Compute HMAC over rawBody as Buffer — never stringify first.
        const expectedHmac = crypto
            .createHmac('sha256', this.webhookSecret)
            .update(rawBody)
            .digest('hex')

        const isValid = crypto.timingSafeEqual(
            Buffer.from(expectedHmac, 'hex'),
            Buffer.from(signatureHeader, 'hex'),
        )
        if (!isValid) {
            throw new UnauthorizedException('Webhook signature mismatch.')
        }

        // Parse body only after signature is verified.
        let event: { event: string; payload?: Record<string, unknown> }
        try {
            const parsed: unknown = JSON.parse(rawBody.toString('utf8'))
            // R-08: Guard against non-object JSON (e.g. null, "str", 123) that would
            // cause a TypeError when reading event.event — Razorpay always delivers
            // object payloads, but a defensive check avoids an unhandled 500.
            if (typeof parsed !== 'object' || parsed === null) {
                this.logger.warn(`Webhook body is valid JSON but not an object (eventId: ${eventId})`)
                return
            }
            event = parsed as typeof event
        } catch {
            this.logger.warn(`Webhook body is not valid JSON (eventId: ${eventId})`)
            return
        }

        const eventType = event.event

        if (eventType === 'order.paid') {
            await this.handleOrderPaid(event.payload ?? {}, eventId, rawBody)
        } else if (eventType === 'payment.failed') {
            await this.handlePaymentFailed(event.payload ?? {}, eventId, rawBody)
        } else {
            this.logger.debug(`Unrecognised webhook event type: ${eventType} — ignoring.`)
        }
    }

    private async handleOrderPaid(
        payload: Record<string, unknown>,
        eventId: string,
        rawBody: Buffer,
    ): Promise<void> {
        const orderEntity = (payload as { order?: { entity?: { id?: string; amount_paid?: number; currency?: string } } })
            .order?.entity
        const paymentEntity = (payload as { payment?: { entity?: { id?: string } } })
            .payment?.entity

        const razorpayOrderId = orderEntity?.id
        const razorpayPaymentId = paymentEntity?.id ?? null
        const amountPaidPaise = orderEntity?.amount_paid ?? null
        const currency = orderEntity?.currency ?? null

        if (!razorpayOrderId) {
            this.logger.warn(`order.paid webhook missing order.entity.id (eventId: ${eventId})`)
            return
        }

        // R-02: creditsGranted is read from the local order (persisted at creation time)
        // inside captureOrder — no longer re-resolved from the package table here.
        // This prevents a zero-credit capture if the package was removed/renamed
        // between order creation and webhook delivery.
        const result = await this.repo.captureOrder({
            razorpayOrderId,
            razorpayPaymentId,
            razorpayEventId: eventId,
            payload: rawBody.toString('utf8') as unknown as Prisma.InputJsonValue,
            amountPaidPaise,
            currency,
        }).catch((err: unknown) => {
            // P2002 = unique constraint on razorpayEventId — duplicate event delivery.
            // P2028 / P2034 = transaction timeout or contention during concurrent duplicate bursts (RZP-005).
            const code = (err as { code?: string })?.code
            if (code === 'P2002' || code === 'P2028' || code === 'P2034') {
                return 'duplicate' as const
            }
            throw err
        })

        switch (result) {
            case 'captured':
                this.logger.log(`order.paid: captured order ${razorpayOrderId}`)
                break
            case 'already_captured':
                this.logger.warn(`order.paid: order ${razorpayOrderId} was already captured — idempotent no-op`)
                break
            case 'not_found':
                // R-04: elevated to error — a paid order with no local row is revenue-impacting.
                this.logger.error(`order.paid: no local order found for ${razorpayOrderId} — may be from a different environment`)
                break
            case 'amount_mismatch':
                // Error already logged in the repository with full context.
                break
            case 'zero_credits':
                // R-02/R-04: order paid but creditsGranted <= 0 — entitlement missing,
                // revenue-impacting. Order left in current status for reconciliation.
                this.logger.error(`order.paid: order ${razorpayOrderId} has zero credits — entitlement missing, left for reconciliation`)
                break
            case 'duplicate':
                this.logger.debug(`order.paid: duplicate or contended event ${eventId} — no-op`)
                break
        }
    }

    private async handlePaymentFailed(
        payload: Record<string, unknown>,
        eventId: string,
        rawBody: Buffer,
    ): Promise<void> {
        // RZP-001: In real Razorpay payment.failed webhooks, order_id lives inside
        // payload.payment.entity.order_id, falling back to payload.order.entity.id.
        const paymentEntity = (payload as { payment?: { entity?: { id?: string; order_id?: string } } })
            .payment?.entity
        const orderEntity = (payload as { order?: { entity?: { id?: string } } })
            .order?.entity

        const razorpayOrderId = paymentEntity?.order_id ?? orderEntity?.id

        if (!razorpayOrderId) {
            this.logger.warn(`payment.failed webhook missing payment.entity.order_id / order.entity.id (eventId: ${eventId})`)
            return
        }

        const transitioned = await this.repo.failOrder({
            razorpayOrderId,
            razorpayEventId: eventId,
            payload: rawBody.toString('utf8') as unknown as Prisma.InputJsonValue,
        }).catch((err: unknown) => {
            const code = (err as { code?: string })?.code
            if (code === 'P2002' || code === 'P2028' || code === 'P2034') return false
            throw err
        })

        if (transitioned) {
            this.logger.warn(`payment.failed: order ${razorpayOrderId} marked FAILED`)
        } else {
            this.logger.debug(`payment.failed: order ${razorpayOrderId} already terminal or unknown — no-op`)
        }
    }

    /** Return wallet response (balance + ledger + available packages). */
    async getWallet(userId: string): Promise<WalletResponse> {
        const { balance, ledger } = await this.repo.getWallet(userId)
        return {
            balance,
            ledger: ledger.map((e) => ({
                id: e.id,
                type: e.type,
                amount: e.amount,
                balanceAfter: e.balanceAfter,
                description: e.description,
                createdAt: e.createdAt.toISOString(),
            })),
            packages: Object.entries(CREDIT_PACKAGES).map(([id, pkg]) => ({
                id,
                label: pkg.label,
                credits: pkg.credits,
                amountPaise: pkg.amountPaise,
                currency: pkg.currency,
            })),
        }
    }

    /**
     * Atomically deduct credits before an expensive operation.
     * Returns the post-deduction balance, or null if balance insufficient (caller should 402).
     */
    async deductCredits(params: {
        userId: string
        cost: number
        reviewId: string | null
        description: string
    }): Promise<number | null> {
        return this.repo.deductCredits(params)
    }

    /**
     * Refund credits after a failed review, using the provided transaction client.
     * Must be called within an existing $transaction (F-05) to ensure atomicity with markFailed.
     */
    async refundCreditsInTx(
        tx: Prisma.TransactionClient,
        params: { userId: string; cost: number; reviewId: string; description: string },
    ): Promise<void> {
        return this.repo.refundCreditsInTx(tx, params)
    }

    /**
     * Refund credits after a handler failure (guard-level refund, S-03/S-04).
     * Creates its own transaction — used when there is no existing transaction context
     * (e.g. when the review-creation handler throws synchronously, or the chat stream errors).
     */
    async refundCredits(params: {
        userId: string
        cost: number
        reviewId: string | null
        description: string
    }): Promise<void> {
        return this.repo.refundCredits(params)
    }

    /**
     * Idempotently grant free signup credits.
     * Safe to call on every login — returns false if already granted.
     * Errors are caught by the caller (UsersService).
     */
    async grantFreeCredits(userId: string): Promise<boolean> {
        return this.repo.grantFreeCredits(userId, FREE_CREDIT_AMOUNT)
    }

    /** Returns the webhook maximum body size constant — used by the webhook controller. */
    static get maxWebhookBodyBytes(): number {
        return WEBHOOK_MAX_BODY_BYTES
    }
}
