import * as crypto from 'crypto'
import { BadGatewayException, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Razorpay from 'razorpay'
import { CreateOrderParams, CreatedOrder, PaymentGateway } from './payment-gateway.interface'

@Injectable()
export class RazorpayGatewayAdapter implements PaymentGateway {
    private readonly logger = new Logger(RazorpayGatewayAdapter.name)
    private readonly razorpay: Razorpay
    private readonly webhookSecret: string

    constructor(private readonly config: ConfigService) {
        this.razorpay = new Razorpay({
            key_id: this.config.getOrThrow<string>('RAZORPAY_KEY_ID'),
            key_secret: this.config.getOrThrow<string>('RAZORPAY_KEY_SECRET'),
        })
        this.webhookSecret = this.config.getOrThrow<string>('RAZORPAY_WEBHOOK_SECRET')
    }

    async createOrder(params: CreateOrderParams): Promise<CreatedOrder> {
        try {
            const order = (await this.razorpay.orders.create({
                amount: params.amountPaise,
                currency: params.currency,
                receipt: params.receipt,
                notes: params.notes,
            })) as { id: string; amount: number; currency: string }

            return {
                id: order.id,
                amount: order.amount,
                currency: order.currency,
            }
        } catch (err) {
            // Sanitise SDK error — do NOT log raw error object (F-10, may contain API keys in headers).
            const msg = err instanceof Error ? err.message : 'Razorpay API error'
            this.logger.error(`Razorpay order creation failed: ${msg}`)
            throw new BadGatewayException('Payment service unavailable. Please try again later.')
        }
    }

    verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean {
        // F-02: Validate signature header format before timingSafeEqual (prevents RangeError on length mismatch).
        if (!/^[0-9a-f]{64}$/.test(signatureHeader)) {
            return false
        }

        // F-01: Compute HMAC over rawBody as Buffer — never stringify first.
        const expectedHmac = crypto
            .createHmac('sha256', this.webhookSecret)
            .update(rawBody)
            .digest('hex')

        return crypto.timingSafeEqual(
            Buffer.from(expectedHmac, 'hex'),
            Buffer.from(signatureHeader, 'hex'),
        )
    }
}
