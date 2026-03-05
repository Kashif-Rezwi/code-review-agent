import { IsString, IsNotEmpty } from 'class-validator'

export class CreateReviewDto {
    @IsString()
    @IsNotEmpty()
    prompt: string
}
