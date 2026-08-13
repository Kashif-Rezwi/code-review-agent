import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class CreateSessionDto {
    @IsIn(['CODE', 'PR'])
    type: 'CODE' | 'PR'

    // 100k chars aligns with the default body-size limit; PR URLs and pastes both fit.
    @IsString()
    @IsNotEmpty()
    @MaxLength(100_000)
    input: string
}
