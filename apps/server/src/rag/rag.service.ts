import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { chunkText } from '@cra/ai'
import { RagRepository, RetrievedStandards } from './rag.repository'
import { extractText } from './document-parser.util'
import { AiService } from '../ai/ai.service'

@Injectable()
export class RagService {
    private readonly logger = new Logger(RagService.name)
    private readonly hasDb: boolean

    constructor(
        private readonly ragRepository: RagRepository,
        private readonly aiService: AiService,
        config: ConfigService,
    ) {
        this.hasDb = !!config.get('DATABASE_URL')
    }

    // ── Ingest ───────────────────────────────────────────────────────────────

    async ingest(buffer: Buffer, mimeType: string, fileName: string, userId: string) {
        this.logger.log(`[RAG Ingest] Booting ingestion for "${fileName}" (${mimeType}).`)
        const text = await extractText(buffer, mimeType)
        const chunks = chunkText(text)

        if (!chunks.length) {
            this.logger.warn(`[RAG Ingest] Failed - Document has no readable content.`)
            throw new BadRequestException('Document has no readable content.')
        }

        this.logger.log(`[RAG Ingest] Extracted ${chunks.length} chunks. Generating embeddings...`)
        // One batched call for all chunks — far fewer round-trips than a loop.
        // Dimensions/task typing live in AiService (the provider boundary).
        const embeddings = await this.aiService.embedDocuments(chunks)

        this.logger.log(`[RAG Ingest SUCCESS] Persisting ${chunks.length} vector chunks to pgvector.`)
        return this.ragRepository.insertDocumentWithEmbeddings(fileName, userId, chunks, embeddings)
    }

    // ── Retrieve ─────────────────────────────────────────────────────────────

    /**
     * Top-5 most relevant chunks for `queryText`, or null — never throws, so reviews
     * degrade gracefully when no standards are uploaded or the DB is unavailable.
     */
    async retrieveForContext(queryText: string, userId: string): Promise<RetrievedStandards | null> {
        if (!this.hasDb) {
            this.logger.log(`[RAG Retrieve] Bypassed - no active DB Connection.`)
            return null
        }

        try {
            // The query IS the user's source code — never log it verbatim (proprietary code/secrets
            // would persist in log pipelines). Length + a short preview is enough to correlate requests.
            const preview = queryText.replace(/\s+/g, ' ').trim()
            const excerpt = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview
            this.logger.log(`[RAG Retrieve] Encoding context query (${queryText.length} chars): "${excerpt}"`)
            const embedding = await this.aiService.embedQuery(queryText)

            const standards = await this.ragRepository.querySimilarChunks(embedding, userId)

            if (standards && standards.appliedNames.length > 0) {
                this.logger.log(`[RAG Retrieve SUCCESS] Embedded ${standards.appliedNames.length} custom standard rules into Model context!`)
            } else {
                this.logger.log(`[RAG Retrieve INFO] No uploaded coding standards found for AI Review injection.`)
            }

            return standards
        } catch (err) {
            this.logger.warn(
                `RAG retrieval encountered an embedding API failure: ${err instanceof Error ? err.message : err}`,
            )
            return null
        }
    }

    // ── List & Delete ─────────────────────────────────────────────────────────

    listDocuments(userId: string) {
        return this.ragRepository.listDocuments(userId)
    }

    async deleteDocument(id: string, userId: string): Promise<void> {
        const deleted = await this.ragRepository.deleteDocument(id, userId)
        if (!deleted) throw new NotFoundException(`Document ${id} not found.`)
    }
}
