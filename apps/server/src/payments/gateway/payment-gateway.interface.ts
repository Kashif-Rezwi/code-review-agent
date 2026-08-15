export interface CreateOrderParams {
    amountPaise: number
    currency: string
    receipt: string
    notes?: Record<string, string>
}

export interface CreatedOrder {
    id: string
    amount: number
    currency: string
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY')

export interface PaymentGateway {
    createOrder(params: CreateOrderParams): Promise<CreatedOrder>
    verifyWebhookSignature(rawBody: Buffer, signatureHeader: string): boolean
}
