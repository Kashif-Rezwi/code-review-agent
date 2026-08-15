import { IsIn, IsNotEmpty, IsString } from 'class-validator'
import { CREDIT_PACKAGES } from '../credit-cost.policy'

export class CreateOrderDto {
    @IsString()
    @IsNotEmpty()
    @IsIn(Object.keys(CREDIT_PACKAGES), {
        message: `packageId must be one of: ${Object.keys(CREDIT_PACKAGES).join(', ')}`,
    })
    packageId: string
}
