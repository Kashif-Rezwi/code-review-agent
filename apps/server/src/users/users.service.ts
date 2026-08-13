import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PaymentsService } from '../payments/payments.service'

export interface GithubProfile {
    id: string        // GitHub numeric user ID as string
    login: string
    name: string | null
    email: string | null
    avatarUrl: string | null
}

@Injectable()
export class UsersService {
    private readonly logger = new Logger(UsersService.name)

    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentsService: PaymentsService,
    ) {}

    /** Upsert a user from their GitHub profile; returns the stored record. */
    async findOrCreate(profile: GithubProfile) {
        const user = await this.prisma.user.upsert({
            where: { id: profile.id },
            update: {
                login: profile.login,
                name: profile.name,
                email: profile.email,
                avatarUrl: profile.avatarUrl,
            },
            create: {
                id: profile.id,
                login: profile.login,
                name: profile.name,
                email: profile.email,
                avatarUrl: profile.avatarUrl,
            },
        })

        // Idempotently grant 25 free credits on first creation (F-15).
        try {
            await this.paymentsService.grantFreeCredits(profile.id)
        } catch (err: unknown) {
            // P2002 or duplicate grant is expected for returning users — log at debug only.
            this.logger.debug(`Free credit grant skipped for user ${profile.id}: ${err instanceof Error ? err.message : String(err)}`)
        }

        return user
    }
}
