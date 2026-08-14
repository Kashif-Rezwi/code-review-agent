import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PaymentsController } from './payments.controller'
import { WebhookController } from './webhook.controller'
import { PaymentsService } from './payments.service'
import { PaymentsRepository } from './payments.repository'
import { CreditRefundInterceptor } from './credit-refund.interceptor'

@Module({
    // AuthModule is required to make AuthGuard injectable in PaymentsController.
    // forwardRef breaks the circular module dependency:
    //   AuthModule → UsersModule → PaymentsModule → AuthModule
    // Without forwardRef, the compiled CommonJS output accesses AuthModule in the
    // temporal dead zone (ReferenceError: Cannot access 'AuthModule' before initialization).
    // PrismaModule is @Global so PaymentsRepository can access PrismaService without re-importing.
    imports: [forwardRef(() => AuthModule)],
    controllers: [PaymentsController, WebhookController],
    providers: [PaymentsService, PaymentsRepository, CreditRefundInterceptor],
    // Export PaymentsService and CreditRefundInterceptor so ReviewModule, HistoryModule,
    // and UsersModule can inject CreditGuard, grantFreeCredits, and the refund interceptor
    // without a circular dependency.
    exports: [PaymentsService, CreditRefundInterceptor],
})
export class PaymentsModule {}
