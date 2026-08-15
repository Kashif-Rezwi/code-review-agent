import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
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

/** Validate every incoming Bearer token via AuthService; on success attach { userId, login, name, avatarUrl } to req.user. */
@Injectable()
export class AuthGuard implements CanActivate {
    private readonly logger = new Logger(AuthGuard.name)

    constructor(private readonly authService: AuthService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>()
        const authHeader = req.headers['authorization']
        let token: string | undefined

        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.slice(7).trim()
        } else if (
            req.query.token && typeof req.query.token === 'string' &&
            !(req.path ?? '').startsWith('/payments/')
        ) {
            // Deprecated fallback: query-param tokens leak into proxy/access logs,
            // browser history and referrer headers. Removal candidate once logs show zero usage.
            // R-07: Payment routes are excluded — token-transmission via query param is
            // unacceptable for payment operations, even as a deprecated fallback.
            this.logger.warn('Auth via ?token= query parameter is deprecated — use the Authorization: Bearer header instead.')
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
