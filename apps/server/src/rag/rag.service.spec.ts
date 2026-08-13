import { NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { AiService } from '../ai/ai.service'
import { RagRepository } from './rag.repository'
import { RagService } from './rag.service'

describe('RagService.deleteDocument', () => {
    const config = { get: jest.fn().mockReturnValue('postgres://example') } as unknown as ConfigService
    const aiService = {} as unknown as AiService

    it('throws NotFoundException when no document was deleted', async () => {
        const repository = { deleteDocument: jest.fn().mockResolvedValue(false) } as unknown as RagRepository
        const service = new RagService(repository, aiService, config)

        await expect(service.deleteDocument('doc-1', 'user-1')).rejects.toThrow(NotFoundException)
    })

    it('resolves when the document was deleted', async () => {
        const deleteDocument = jest.fn().mockResolvedValue(true)
        const repository = { deleteDocument } as unknown as RagRepository
        const service = new RagService(repository, aiService, config)

        await expect(service.deleteDocument('doc-1', 'user-1')).resolves.toBeUndefined()
        expect(deleteDocument).toHaveBeenCalledWith('doc-1', 'user-1')
    })
})
