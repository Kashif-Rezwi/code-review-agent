import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service'
import { randomUUID } from 'crypto'

export interface RetrievedStandards {
    content: string
    appliedNames: string[]
}

interface ChunkRow {
    content: string
    name: string
}

@Injectable()
export class RagRepository {
    private readonly logger = new Logger(RagRepository.name)
    private readonly hasDb: boolean

    constructor(
        private readonly prisma: PrismaService,
        config: ConfigService,
    ) {
        this.hasDb = !!config.get('DATABASE_URL')
    }

    /**
     * Inserts the document and its chunked embeddings atomically via raw pgvector INSERTs.
     * Raw $executeRaw is necessary because Prisma ORM lacks native vector column write support.
     */
    async insertDocumentWithEmbeddings(
        fileName: string,
        userId: string,
        chunks: string[],
        embeddings: number[][]
    ) {
        return this.prisma.$transaction(async (tx) => {
            const doc = await tx.document.create({ data: { userId, name: fileName } })

            for (let i = 0; i < chunks.length; i++) {
                await tx.$executeRaw`
                    INSERT INTO "DocumentChunk" (id, "documentId", content, embedding)
                    VALUES (${randomUUID()}, ${doc.id}, ${chunks[i]}, ${`[${embeddings[i].join(',')}]`}::vector)
                `
            }

            this.logger.log(`Ingested "${fileName}" → ${chunks.length} chunk(s)`)
            return { id: doc.id, name: doc.name, createdAt: doc.createdAt }
        })
    }

    /**
     * Executes a cosine distance query using pgvector index against the provided embedding.
     */
    async querySimilarChunks(embedding: number[], userId: string): Promise<RetrievedStandards | null> {
        if (!this.hasDb) return null

        try {
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
            this.logger.warn(`RAG repository vector similarity search failed: ${err instanceof Error ? err.message : err}`)
            return null
        }
    }

    listDocuments(userId: string) {
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

    deleteDocument(id: string, userId: string) {
        return this.prisma.document.delete({ where: { id, userId } })
    }
}
