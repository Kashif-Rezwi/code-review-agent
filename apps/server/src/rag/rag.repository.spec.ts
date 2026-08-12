import { ConfigService } from '@nestjs/config'

import { PrismaService } from '../prisma/prisma.service'
import { RagRepository } from './rag.repository'

describe('RagRepository.deleteDocument', () => {
    const config = { get: jest.fn().mockReturnValue('postgres://example') } as unknown as ConfigService

    it('deletes via deleteMany scoped to the owner and reports whether a row existed', async () => {
        const document = {
            deleteMany: jest.fn()
                .mockResolvedValueOnce({ count: 1 })
                .mockResolvedValueOnce({ count: 0 }),
        }
        const repository = new RagRepository({ document } as unknown as PrismaService, config)

        await expect(repository.deleteDocument('doc-1', 'user-1')).resolves.toBe(true)
        await expect(repository.deleteDocument('doc-1', 'user-1')).resolves.toBe(false)
        expect(document.deleteMany).toHaveBeenCalledWith({ where: { id: 'doc-1', userId: 'user-1' } })
    })
})
