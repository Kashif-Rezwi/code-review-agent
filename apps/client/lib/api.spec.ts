import { describe, expect, it } from 'vitest'
import { apiErrorMessage } from './api'

describe('apiErrorMessage', () => {
    it('extracts Nest message fields instead of displaying raw JSON', async () => {
        const response = new Response(JSON.stringify({
            message: 'Database schema is not ready',
            error: 'Internal Server Error',
            statusCode: 500,
        }), { status: 500 })

        await expect(apiErrorMessage(response)).resolves.toBe('Database schema is not ready')
    })
})
