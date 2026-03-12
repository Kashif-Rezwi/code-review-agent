import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createOpenAI } from '@ai-sdk/openai'
import { embed, embedMany } from 'ai'
import { randomUUID } from 'crypto'
import { chunkText } from '@cra/ai'
import { PrismaService } from '../prisma/prisma.service'

export interface RetrievedStandards {
    content: string
    appliedNames: string[]
}

interface ChunkRow {
    content: string
    name: string
}

@Injectable()
export class RagService {
    private readonly logger = new Logger(RagService.name)
    private readonly openai: ReturnType<typeof createOpenAI>
    /** Cached at startup — avoids a config lookup on every retrieval. */
    private readonly hasDb: boolean

    constructor(
        private readonly prisma: PrismaService,
        config: ConfigService,
    ) {
        this.openai = createOpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') })
        this.hasDb = !!config.get('DATABASE_URL')
    }

    // ── Ingest ───────────────────────────────────────────────────────────────

    async ingest(buffer: Buffer, mimeType: string, fileName: string, userId = 'default') {
        const text = await this.extractText(buffer, mimeType)
        const chunks = chunkText(text)

        if (!chunks.length) {
            throw new BadRequestException('Document has no readable content.')
        }

        // One batched API call for all chunks — far fewer round-trips than a loop
        const { embeddings } = await embedMany({
            model: this.openai.embedding('text-embedding-3-small'),
            values: chunks,
        })

        // Atomic: if any INSERT fails the whole document is rolled back
        return this.prisma.$transaction(async (tx) => {
            const doc = await tx.document.create({ data: { userId, name: fileName } })

            for (let i = 0; i < chunks.length; i++) {
                // Prisma ORM cannot write vector columns — raw INSERT is required
                await tx.$executeRaw`
                    INSERT INTO "DocumentChunk" (id, "documentId", content, embedding)
                    VALUES (${randomUUID()}, ${doc.id}, ${chunks[i]}, ${`[${embeddings[i].join(',')}]`}::vector)
                `
            }

            this.logger.log(`Ingested "${fileName}" → ${chunks.length} chunk(s)`)
            return { id: doc.id, name: doc.name, createdAt: doc.createdAt }
        })
    }

    // ── Retrieve ─────────────────────────────────────────────────────────────

    /**
     * Returns the top-5 most relevant chunks for `queryText`.
     * Returns null — never throws — so reviews degrade gracefully when
     * no standards are uploaded or the DB is unavailable.
     */
    async retrieveForContext(queryText: string, userId = 'default'): Promise<RetrievedStandards | null> {
        if (!this.hasDb) return null

        try {
            const { embedding } = await embed({
                model: this.openai.embedding('text-embedding-3-small'),
                value: queryText,
            })

            const rows = await this.prisma.$queryRaw<ChunkRow[]>`
                SELECT dc.content, d.name
                FROM "DocumentChunk" dc
                JOIN "Document" d ON dc."documentId" = d.id
                WHERE d."userId" = ${userId}
                  AND dc.embedding IS NOT NULL
                ORDER BY dc.embedding <=> ${`[${embedding.join(',')}]`}::vector
                LIMIT 5
            `

            if (!rows.length) return null

            return {
                content: rows.map((r) => r.content).join('\n\n---\n\n'),
                appliedNames: [...new Set(rows.map((r) => r.name))],
            }
        } catch (err) {
            this.logger.warn(
                `RAG retrieval failed, review will proceed without standards: ${err instanceof Error ? err.message : err}`,
            )
            return null
        }
    }

    // ── List & Delete ─────────────────────────────────────────────────────────

    listDocuments(userId = 'default') {
        return this.prisma.document.findMany({
            where: { userId },
            select: {
                id: true,
                name: true,
                createdAt: true,
                _count: { select: { chunks: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    }

    deleteDocument(id: string, userId = 'default') {
        return this.prisma.document.delete({ where: { id, userId } })
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async extractText(buffer: Buffer, mimeType: string): Promise<string> {
        if (mimeType === 'application/pdf') {
            // Dynamic import — pdf-parse has side-effects that break Jest at the top level
            const pdfParse = (await import('pdf-parse')).default
            return (await pdfParse(buffer)).text
        }
        return buffer.toString('utf-8')
    }
}
