/* eslint-disable @typescript-eslint/unbound-method */
import * as crypto from 'crypto'
import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common'
import { PaymentsService } from './payments.service'
import { PaymentsRepository } from './payments.repository'

describe('PaymentsService & Webhook handling', () => {
    let service: PaymentsService
    let repo: jest.Mocked<PaymentsRepository>

    const WEBHOOK_SECRET = 'test_webhook_secret_1234567890'
    const KEY_ID = 'rzp_test_key_123'
    const KEY_SECRET = 'rzp_test_secret_123'

    beforeEach(async () => {
        const mockRepo = {
            createOrder: jest.fn(),
            findOrderByRazorpayId: jest.fn(),
            captureOrder: jest.fn(),
            failOrder: jest.fn(),
            getWallet: jest.fn(),
            deductCredits: jest.fn(),
            refundCreditsInTx: jest.fn(),
            grantFreeCredits: jest.fn(),
            countPendingOrders: jest.fn().mockResolvedValue(0),
        }

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentsService,
                { provide: PaymentsRepository, useValue: mockRepo },
                {
                    provide: ConfigService,
                    useValue: {
                        getOrThrow: jest.fn((key: string) => {
                            if (key === 'RAZORPAY_WEBHOOK_SECRET') return WEBHOOK_SECRET
                            if (key === 'RAZORPAY_KEY_ID') return KEY_ID
                            if (key === 'RAZORPAY_KEY_SECRET') return KEY_SECRET
                            throw new Error(`Unexpected key: ${key}`)
                        }),
                    },
                },
            ],
        }).compile()

        service = module.get<PaymentsService>(PaymentsService)
        repo = module.get(PaymentsRepository)
    })

    function signPayload(body: Buffer, secret = WEBHOOK_SECRET): string {
        return crypto.createHmac('sha256', secret).update(body).digest('hex')
    }

    describe('handleWebhook', () => {
        it('WH-01: valid HMAC signature + valid event-id -> processes event', async () => {
            const bodyObj = {
                event: 'order.paid',
                payload: {
                    order: { entity: { id: 'order_123', amount_paid: 9900 } },
                    payment: { entity: { id: 'pay_123' } },
                },
            }
            const bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
            const sig = signPayload(bodyBuffer)

            repo.findOrderByRazorpayId.mockResolvedValue({
                id: 'local_1',
                userId: 'user_1',
                razorpayOrderId: 'order_123',
                packageId: '50',
                amountPaise: 9900,
                status: 'CREATED',
            } as any)
            repo.captureOrder.mockResolvedValue('captured')

            const { captureOrder } = repo
            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_123')).resolves.not.toThrow()
            expect(captureOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    razorpayOrderId: 'order_123',
                    razorpayPaymentId: 'pay_123',
                    creditsGranted: 50,
                    razorpayEventId: 'evt_123',
                    amountPaidPaise: 9900,
                }),
            )
        })

        it('WH-02: invalid HMAC signature -> rejects with 401 UnauthorizedException', async () => {
            const bodyBuffer = Buffer.from(JSON.stringify({ event: 'order.paid' }))
            const invalidSig = 'a'.repeat(64)

            await expect(service.handleWebhook(bodyBuffer, invalidSig, 'evt_123')).rejects.toThrow(
                UnauthorizedException,
            )
        })

        it('WH-04: body modified by 1 char -> rejects with 401', async () => {
            const originalBody = Buffer.from(JSON.stringify({ event: 'order.paid', test: 1 }))
            const sig = signPayload(originalBody)

            const tamperedBody = Buffer.from(JSON.stringify({ event: 'order.paid', test: 2 }))
            await expect(service.handleWebhook(tamperedBody, sig, 'evt_123')).rejects.toThrow(
                UnauthorizedException,
            )
        })

        it('WH-05 & WH-06: malformed signature format (short or empty) -> rejects 401 without 500', async () => {
            const bodyBuffer = Buffer.from(JSON.stringify({ event: 'order.paid' }))
            await expect(service.handleWebhook(bodyBuffer, '', 'evt_123')).rejects.toThrow(UnauthorizedException)
            await expect(service.handleWebhook(bodyBuffer, 'a', 'evt_123')).rejects.toThrow(UnauthorizedException)
        })

        it('WH-09: duplicate event -> repo returns duplicate and service resolves smoothly', async () => {
            const bodyObj = {
                event: 'order.paid',
                payload: { order: { entity: { id: 'order_123', amount_paid: 9900 } } },
            }
            const bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
            const sig = signPayload(bodyBuffer)

            repo.findOrderByRazorpayId.mockResolvedValue({ packageId: '50' } as any)
            const p2002Error: any = new Error('Unique constraint failed')
            p2002Error.code = 'P2002'
            repo.captureOrder.mockRejectedValue(p2002Error)

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_123')).resolves.not.toThrow()
        })
    })

    describe('createOrder', () => {
        it('F-11: pending order cap >= 3 throws 429 TooManyRequests', async () => {
            repo.countPendingOrders.mockResolvedValue(3)

            await expect(service.createOrder('50', 'user_1')).rejects.toThrow(HttpException)
            await expect(service.createOrder('50', 'user_1')).rejects.toMatchObject({
                status: HttpStatus.TOO_MANY_REQUESTS,
            })
        })
    })
})
