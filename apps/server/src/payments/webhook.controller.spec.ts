/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing'
import { WebhookController } from './webhook.controller'
import { PaymentsService } from './payments.service'
import { UnauthorizedException, PayloadTooLargeException, BadRequestException } from '@nestjs/common'

describe('WebhookController', () => {
    let controller: WebhookController
    let service: jest.Mocked<PaymentsService>

    beforeEach(async () => {
        const mockService = {
            handleWebhook: jest.fn().mockResolvedValue(undefined),
        }

        const module: TestingModule = await Test.createTestingModule({
            controllers: [WebhookController],
            providers: [{ provide: PaymentsService, useValue: mockService }],
        }).compile()

        controller = module.get<WebhookController>(WebhookController)
        service = module.get(PaymentsService)
    })

    it('should throw UnauthorizedException if X-Razorpay-Signature is missing or invalid', async () => {
        const req: any = { rawBody: Buffer.from('{}') }
        await expect(controller.handleWebhook(req, undefined, 'evt_1')).rejects.toThrow(UnauthorizedException)
        await expect(controller.handleWebhook(req, 'invalid', 'evt_1')).rejects.toThrow(UnauthorizedException)
    })

    it('F-03: should throw PayloadTooLargeException if rawBody exceeds 1 MB', async () => {
        const req: any = { rawBody: Buffer.alloc(1_048_577) }
        const sig = 'a'.repeat(64)
        await expect(controller.handleWebhook(req, sig, 'evt_1')).rejects.toThrow(PayloadTooLargeException)
    })

    it('F-08: should throw BadRequestException if x-razorpay-event-id is missing', async () => {
        const req: any = { rawBody: Buffer.from('{}') }
        const sig = 'a'.repeat(64)
        await expect(controller.handleWebhook(req, sig, undefined)).rejects.toThrow(BadRequestException)
    })

    it('should delegate to PaymentsService when headers and payload size are valid', async () => {
        const { handleWebhook } = service
        const req: any = { rawBody: Buffer.from('{"event":"order.paid"}') }
        const sig = 'a'.repeat(64)
        const res = await controller.handleWebhook(req, sig, 'evt_123')
        expect(res).toEqual({ received: true })
        expect(handleWebhook).toHaveBeenCalledWith(req.rawBody, sig, 'evt_123')
    })
})
