import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Rate-limit paid endpoints by authenticated userId rather than IP (IP-keying breaks users
 * behind NAT). Must run AFTER AuthGuard so `req.user` is populated (controller guards run before route guards).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    protected getTracker(req: Record<string, any>): Promise<string> {
        const user = req.user as { userId?: string } | undefined
        return Promise.resolve(user?.userId ?? (req.ip as string | undefined) ?? 'unknown')
    }
}
