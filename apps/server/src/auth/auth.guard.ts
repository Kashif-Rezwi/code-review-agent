import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common'
import { Request } from 'express'
import { AuthService } from './auth.service'

/** Shape of the authenticated user attached to req.user by AuthGuard. */
export interface AuthUser {
    userId: string
    login: string
    name: string | null
    avatarUrl: string | null
}

/**
 * AuthGuard — validates every incoming Bearer token by delegating to AuthService.
 *
 * On success, attaches { userId, login, name, avatarUrl } to req.user.
 */
@Injectable()
export class AuthGuard implements CanActivate {
    constructor(private readonly authService: AuthService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>()
        const authHeader = req.headers['authorization']
        let token: string | undefined

        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim()
        } else if (req.query.token && typeof req.query.token === 'string') {
            token = req.query.token
        }

        if (!token) {
            throw new UnauthorizedException('Missing or malformed Authorization token.')
        }

        const entry = await this.authService.resolve(token)

        req.user = {
            userId: entry.userId,
            login: entry.login,
            name: entry.name,
            avatarUrl: entry.avatarUrl,
        }

        return true
    }
}
