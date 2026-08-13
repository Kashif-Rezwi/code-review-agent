import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    Logger,
    PayloadTooLargeException,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request } from 'express'
import { PaymentsService } from './payments.service'

/**
 * Dedicated controller for the Razorpay webhook endpoint.
 * Intentionally has NO @UseGuards(AuthGuard) — Razorpay cannot authenticate via GitHub Bearer tokens.
 * Security is enforced entirely by HMAC-SHA256 signature verification in PaymentsService.
 *
 * Follows the HealthController precedent for unauthenticated routes.
 */
@Controller('payments')
export class WebhookController {
    private readonly logger = new Logger(WebhookController.name)

    constructor(private readonly paymentsService: PaymentsService) {}

    @Post('webhook')
    @HttpCode(200)
    async handleWebhook(
        @Req() req: RawBodyRequest<Request>,
        @Headers('x-razorpay-signature') signatureHeader: string | undefined,
        @Headers('x-razorpay-event-id') eventIdHeader: string | undefined,
    ): Promise<{ received: boolean }> {
        // F-03: Body-size check before any processing.
        const rawBody = req.rawBody
        if (!rawBody || rawBody.length > PaymentsService.maxWebhookBodyBytes) {
            throw new PayloadTooLargeException('Webhook payload exceeds maximum allowed size.')
        }

        // F-02: Signature header must be present and exactly 64 hex characters.
        if (!signatureHeader || !/^[0-9a-f]{64}$/.test(signatureHeader)) {
            throw new UnauthorizedException('Missing or malformed X-Razorpay-Signature header.')
        }

        // F-08: Event ID must be present and within length bounds.
        if (!eventIdHeader || eventIdHeader.length > 128) {
            throw new BadRequestException('Missing or invalid x-razorpay-event-id header.')
        }

        await this.paymentsService.handleWebhook(rawBody, signatureHeader, eventIdHeader)
        return { received: true }
    }
}
