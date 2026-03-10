import { IsString, IsUrl } from 'class-validator'

export class CreatePRReviewDto {
    @IsString()
    @IsUrl()
    prUrl: string
}
