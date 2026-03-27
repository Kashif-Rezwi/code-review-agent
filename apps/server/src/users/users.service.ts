import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

export interface GithubProfile {
    id: string        // GitHub numeric user ID as string
    login: string
    name: string | null
    email: string | null
    avatarUrl: string | null
}

@Injectable()
export class UsersService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Upserts a user from their GitHub profile.
     * Returns the stored user record.
     */
    async findOrCreate(profile: GithubProfile) {
        return this.prisma.user.upsert({
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
    }
}
