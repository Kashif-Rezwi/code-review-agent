import type { AuthUser } from '../auth/auth.guard'

declare global {
    namespace Express {
        interface Request {
            /** Attached by AuthGuard after validating the Bearer token against GitHub /user. */
            user?: AuthUser
        }
    }
}
