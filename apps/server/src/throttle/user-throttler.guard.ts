import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Rate-limits paid endpoints by authenticated userId rather than IP
 * (IP-keying breaks users behind NAT and over-counts shared networks).
 *
 * Must run AFTER AuthGuard so `req.user` is populated: AuthGuard is applied at
 * the controller level, this guard at the route level — Nest executes
 * controller guards before route guards.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
    protected getTracker(req: Record<string, any>): Promise<string> {
        const user = req.user as { userId?: string } | undefined
        return Promise.resolve(user?.userId ?? (req.ip as string | undefined) ?? 'unknown')
    }
}
