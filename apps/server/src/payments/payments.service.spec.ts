/* eslint-disable @typescript-eslint/unbound-method */
import * as crypto from 'crypto'
import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { UnauthorizedException, HttpException, HttpStatus, BadRequestException } from '@nestjs/common'
import { PaymentsService } from './payments.service'
import { PaymentsRepository } from './payments.repository'
import { PAYMENT_GATEWAY, PaymentGateway } from './gateway/payment-gateway.interface'
import { RazorpayGatewayAdapter } from './gateway/razorpay-gateway.adapter'

describe('PaymentsService & Webhook handling', () => {
    let service: PaymentsService
    let repo: jest.Mocked<PaymentsRepository>
    let configGet: jest.Mock
    let gateway: PaymentGateway

    const WEBHOOK_SECRET = 'test_webhook_secret_1234567890'
    const KEY_ID = 'rzp_test_key_123'
    const KEY_SECRET = 'rzp_test_secret_123'
    const DEV_PACK_SECRET = 'test_dev_pack_secret'

    beforeEach(async () => {
        const mockRepo = {
            createOrder: jest.fn(),
            findOrderByRazorpayId: jest.fn(),
            captureOrder: jest.fn(),
            failOrder: jest.fn(),
            getWallet: jest.fn(),
            deductCredits: jest.fn(),
            refundCreditsInTx: jest.fn(),
            refundCredits: jest.fn().mockResolvedValue(undefined),
            grantFreeCredits: jest.fn(),
            countPendingOrders: jest.fn().mockResolvedValue(0),
        }

        // Default: PAYMENTS_DEV_PACK is unset — the hidden dev pack stays disabled.
        configGet = jest.fn((key: string) => (key === 'PAYMENTS_DEV_PACK' ? DEV_PACK_SECRET : undefined))

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentsService,
                { provide: PaymentsRepository, useValue: mockRepo },
                {
                    provide: ConfigService,
                    useValue: {
                        get: configGet,
                        getOrThrow: jest.fn((key: string) => {
                            if (key === 'RAZORPAY_WEBHOOK_SECRET') return WEBHOOK_SECRET
                            if (key === 'RAZORPAY_KEY_ID') return KEY_ID
                            if (key === 'RAZORPAY_KEY_SECRET') return KEY_SECRET
                            throw new Error(`Unexpected key: ${key}`)
                        }),
                    },
                },
                {
                    provide: PAYMENT_GATEWAY,
                    useClass: RazorpayGatewayAdapter,
                },
            ],
        }).compile()

        service = module.get<PaymentsService>(PaymentsService)
        repo = module.get(PaymentsRepository)
        gateway = module.get(PAYMENT_GATEWAY)
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
                    razorpayEventId: 'evt_123',
                    amountPaidPaise: 9900,
                }),
            )
            // R-02: creditsGranted is no longer passed to captureOrder — it is read
            // from the local order inside the repository method.
            expect(captureOrder).not.toHaveBeenCalledWith(
                expect.objectContaining({ creditsGranted: expect.anything() }),
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

        it('S-05: extracts currency from webhook payload and passes it to captureOrder', async () => {
            const bodyObj = {
                event: 'order.paid',
                payload: {
                    order: { entity: { id: 'order_456', amount_paid: 34900, currency: 'INR' } },
                    payment: { entity: { id: 'pay_456' } },
                },
            }
            const bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
            const sig = signPayload(bodyBuffer)

            repo.findOrderByRazorpayId.mockResolvedValue({ packageId: '200' } as any)
            repo.captureOrder.mockResolvedValue('captured')

            const { captureOrder } = repo
            await service.handleWebhook(bodyBuffer, sig, 'evt_456')
            expect(captureOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    amountPaidPaise: 34900,
                    currency: 'INR',
                }),
            )
        })

        it('R-08: valid JSON but non-object body (null) -> returns gracefully without 500', async () => {
            const bodyBuffer = Buffer.from('null')
            const sig = signPayload(bodyBuffer)

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_null')).resolves.not.toThrow()
            // captureOrder should NOT be called — the body is not an object.
            expect(repo.captureOrder).not.toHaveBeenCalled()
        })

        it('R-08: valid JSON but non-object body (string) -> returns gracefully without 500', async () => {
            const bodyBuffer = Buffer.from('"hello"')
            const sig = signPayload(bodyBuffer)

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_str')).resolves.not.toThrow()
            expect(repo.captureOrder).not.toHaveBeenCalled()
        })

        it('RZP-001: payment.failed webhook parses order_id from payload.payment.entity.order_id', async () => {
            const bodyObj = {
                event: 'payment.failed',
                payload: {
                    payment: {
                        entity: {
                            id: 'pay_fail_123',
                            order_id: 'order_fail_123',
                            error_code: 'BAD_REQUEST_ERROR',
                        },
                    },
                },
            }
            const bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
            const sig = signPayload(bodyBuffer)

            repo.failOrder.mockResolvedValue(true)

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_fail_123')).resolves.not.toThrow()
            expect(repo.failOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    razorpayOrderId: 'order_fail_123',
                    razorpayEventId: 'evt_fail_123',
                }),
            )
        })

        it('RZP-002: order.paid for unknown order acknowledges 200 without throwing', async () => {
            const bodyObj = {
                event: 'order.paid',
                payload: {
                    order: { entity: { id: 'order_unknown', amount_paid: 9900 } },
                },
            }
            const bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
            const sig = signPayload(bodyBuffer)

            repo.captureOrder.mockResolvedValue('not_found')

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_unk_123')).resolves.not.toThrow()
            expect(repo.captureOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    razorpayOrderId: 'order_unknown',
                    razorpayEventId: 'evt_unk_123',
                }),
            )
        })

        it('RZP-005: handles P2028 transaction timeout and P2034 write conflict as idempotent ack', async () => {
            const bodyObj = {
                event: 'order.paid',
                payload: {
                    order: { entity: { id: 'order_123', amount_paid: 9900 } },
                },
            }
            const bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
            const sig = signPayload(bodyBuffer)

            const p2028Err: any = new Error('P2028 timeout')
            p2028Err.code = 'P2028'
            repo.captureOrder.mockRejectedValueOnce(p2028Err)

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_p2028')).resolves.not.toThrow()

            const p2034Err: any = new Error('P2034 conflict')
            p2034Err.code = 'P2034'
            repo.captureOrder.mockRejectedValueOnce(p2034Err)

            await expect(service.handleWebhook(bodyBuffer, sig, 'evt_p2034')).resolves.not.toThrow()
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

        it('dev pack disabled without x-dev-pack header: createOrder("dev1") throws BadRequestException', async () => {
            await expect(service.createOrder('dev1', 'user_1')).rejects.toThrow(BadRequestException)
            expect(repo.createOrder).not.toHaveBeenCalled()
        })

        it('dev pack enabled (x-dev-pack header matches env secret): creates a ₹1 order for 1 credit', async () => {
            const gatewaySpy = jest
                .spyOn(gateway, 'createOrder')
                .mockResolvedValue({ id: 'order_dev_123', amount: 100, currency: 'INR' })
            repo.createOrder.mockResolvedValue({ id: 'local_dev_1' } as any)

            const result = await service.createOrder('dev1', 'user_1', DEV_PACK_SECRET)

            expect(gatewaySpy).toHaveBeenCalledWith({
                amountPaise: 100,
                currency: 'INR',
                receipt: expect.any(String),
                notes: { packageId: 'dev1' },
            })
            expect(repo.createOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageId: 'dev1',
                    amountPaise: 100,
                    currency: 'INR',
                    creditsGranted: 97, // floor(100 / 1.0236) — ₹1 minus the Razorpay fee haircut
                }),
            )
            expect(result).toMatchObject({
                orderId: 'local_dev_1',
                razorpayOrderId: 'order_dev_123',
                amount: 100,
                currency: 'INR',
                keyId: KEY_ID,
            })
        })

        it('dev pack disabled when the header does not match the env secret', async () => {
            await expect(service.createOrder('dev1', 'user_1', 'wrong_value')).rejects.toThrow(BadRequestException)
            expect(repo.createOrder).not.toHaveBeenCalled()
        })

        it('dev pack disabled when the env secret is unset even with a header present', async () => {
            configGet.mockReturnValue(undefined)

            await expect(service.createOrder('dev1', 'user_1', DEV_PACK_SECRET)).rejects.toThrow(BadRequestException)
            expect(repo.createOrder).not.toHaveBeenCalled()
        })

        it('unknown packageId throws BadRequestException regardless of dev pack header', async () => {
            await expect(service.createOrder('nope', 'user_1')).rejects.toThrow(BadRequestException)
            await expect(service.createOrder('nope', 'user_1', DEV_PACK_SECRET)).rejects.toThrow(BadRequestException)
        })
    })

    describe('getWallet packages', () => {
        it('excludes the dev pack without an x-dev-pack header', async () => {
            repo.getWallet.mockResolvedValue({ balance: 0, ledger: [] } as any)

            const wallet = await service.getWallet('user_1')

            expect(wallet.packages.map((p) => p.id)).toEqual(['5', '10', '50'])
        })

        it('includes the dev pack when the x-dev-pack header matches the env secret', async () => {
            repo.getWallet.mockResolvedValue({ balance: 0, ledger: [] } as any)

            const wallet = await service.getWallet('user_1', DEV_PACK_SECRET)

            expect(wallet.packages.map((p) => p.id)).toEqual(['5', '10', '50', 'dev1'])
            expect(wallet.packages.find((p) => p.id === 'dev1')).toMatchObject({
                credits: 97, // floor(100 / 1.0236)
                amountPaise: 100,
                currency: 'INR',
            })
        })
    })
})

