/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing'
import { UsersService, GithubProfile } from '../users/users.service'
import { PrismaService } from '../prisma/prisma.service'
import { PaymentsService } from './payments.service'

describe('Free Credit Grant on Signup', () => {
    let usersService: UsersService
    let paymentsService: jest.Mocked<PaymentsService>

    beforeEach(async () => {
        const mockPrisma = {
            user: {
                upsert: jest.fn().mockResolvedValue({ id: 'user_123', login: 'testuser' }),
            },
        }

        const mockPaymentsService = {
            grantFreeCredits: jest.fn().mockResolvedValue(true),
        }

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UsersService,
                { provide: PrismaService, useValue: mockPrisma },
                { provide: PaymentsService, useValue: mockPaymentsService },
            ],
        }).compile()

        usersService = module.get<UsersService>(UsersService)
        paymentsService = module.get(PaymentsService)
    })

    const profile: GithubProfile = {
        id: 'user_123',
        login: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        avatarUrl: 'https://example.com/avatar.png',
    }

    it('should grant free credits on first findOrCreate call', async () => {
        const { grantFreeCredits } = paymentsService
        const user = await usersService.findOrCreate(profile)
        expect(user).toBeDefined()
        expect(grantFreeCredits).toHaveBeenCalledWith('user_123')
    })

    it('F-15: should catch errors from grantFreeCredits gracefully and return user', async () => {
        paymentsService.grantFreeCredits.mockRejectedValue(new Error('Already granted'))
        const user = await usersService.findOrCreate(profile)
        expect(user).toBeDefined()
        expect(user.id).toBe('user_123')
    })
})
