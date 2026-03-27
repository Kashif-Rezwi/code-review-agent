import { Controller, Get, UseGuards, Req } from '@nestjs/common'
import { Request } from 'express'
import { AuthGuard } from './auth.guard'

/** Exposes auth-related endpoints. */
@Controller('auth')
export class AuthController {
    /** Returns the currently authenticated user's profile. */
    @UseGuards(AuthGuard)
    @Get('me')
    me(@Req() req: Request) {
        return (req as any).user
    }
}
