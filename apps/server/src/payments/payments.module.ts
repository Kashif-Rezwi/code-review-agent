import { Module } from '@nestjs/common'
import { PaymentsController } from './payments.controller'
import { WebhookController } from './webhook.controller'
import { PaymentsService } from './payments.service'
import { PaymentsRepository } from './payments.repository'
import { PAYMENT_GATEWAY } from './gateway/payment-gateway.interface'
import { RazorpayGatewayAdapter } from './gateway/razorpay-gateway.adapter'

@Module({
    // AuthModule is @Global so AuthGuard is accessible without importing AuthModule.
    // PrismaModule is @Global so PaymentsRepository can access PrismaService without re-importing.
    imports: [],
    controllers: [PaymentsController, WebhookController],
    providers: [
        PaymentsService,
        PaymentsRepository,
        {
            provide: PAYMENT_GATEWAY,
            useClass: RazorpayGatewayAdapter,
        },
    ],
    // Export PaymentsService and PaymentsRepository so ReviewModule, HistoryModule,
    // and UsersModule can interact with payments and credits without circular dependencies.
    exports: [PaymentsService, PaymentsRepository],
})
export class PaymentsModule {}
