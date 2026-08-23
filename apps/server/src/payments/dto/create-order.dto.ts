import { IsNotEmpty, IsString } from 'class-validator'

export class CreateOrderDto {
    // Package membership is validated in PaymentsService.createOrder — the available
    // package list is gated by a runtime secret (dev pack) and cannot be evaluated
    // here at decorator time.
    @IsString()
    @IsNotEmpty()
    packageId: string
}
