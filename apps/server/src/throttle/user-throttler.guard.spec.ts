import { UserThrottlerGuard } from './user-throttler.guard'

class TestableGuard extends UserThrottlerGuard {
    tracker(req: Record<string, any>): Promise<string> {
        return this.getTracker(req)
    }
}

describe('UserThrottlerGuard tracker keying', () => {
    // getTracker never touches the constructor deps — safe to stub them out.
    const guard = new TestableGuard({} as never, {} as never, {} as never)

    it('keys by the authenticated userId when AuthGuard has populated req.user', async () => {
        await expect(guard.tracker({ user: { userId: 'user-42' }, ip: '1.2.3.4' })).resolves.toBe('user-42')
    })

    it('falls back to the client IP when no user is attached', async () => {
        await expect(guard.tracker({ ip: '1.2.3.4' })).resolves.toBe('1.2.3.4')
    })
})
