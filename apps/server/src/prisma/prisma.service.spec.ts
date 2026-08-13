import { Logger } from '@nestjs/common'

import { PrismaService } from './prisma.service'

describe('PrismaService resilient boot', () => {
    it('logs and continues when the initial $connect fails', async () => {
        const service = new PrismaService()
        jest.spyOn(service, '$connect').mockRejectedValue(new Error('connection refused'))
        const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

        await expect(service.onModuleInit()).resolves.toBeUndefined()
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('continuing degraded'))

        errorSpy.mockRestore()
    })
})
